//! Change gate helpers: decide cheaply whether a frame or an utterance is worth
//! sending to the models, so a still camera and idle chatter cost nothing.

use anyhow::Context;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, ExtendedColorType, ImageFormat};

pub struct FrameInfo {
    /// 64-bit difference hash: similar-looking frames differ in only a few bits.
    pub hash: u64,
    /// Variance of the Laplacian; low values mean a blurry frame.
    pub sharpness: f64,
}

fn decode(jpeg: &[u8]) -> anyhow::Result<DynamicImage> {
    image::load_from_memory_with_format(jpeg, ImageFormat::Jpeg).context("decoding JPEG")
}

pub fn analyse(jpeg: &[u8]) -> anyhow::Result<FrameInfo> {
    let gray = decode(jpeg)?.thumbnail(160, 160).to_luma8();

    // Difference hash: shrink to 9x8 and record whether each pixel is brighter than its right neighbour.
    let tiny = image::imageops::resize(&gray, 9, 8, FilterType::Triangle);
    let mut hash = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            hash = (hash << 1) | u64::from(tiny.get_pixel(x, y)[0] > tiny.get_pixel(x + 1, y)[0]);
        }
    }

    let (w, h) = gray.dimensions();
    let px = |x: u32, y: u32| f64::from(gray.get_pixel(x, y)[0]);
    let mut values = Vec::new();
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            values.push(4.0 * px(x, y) - px(x - 1, y) - px(x + 1, y) - px(x, y - 1) - px(x, y + 1));
        }
    }
    let n = values.len().max(1) as f64;
    let mean = values.iter().sum::<f64>() / n;
    let sharpness = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n;

    Ok(FrameInfo { hash, sharpness })
}

/// Number of differing bits between two frame hashes (0 = identical, 64 = opposite).
pub fn distance(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// Smaller copies of a frame: one for the models, one thumbnail to store with a memory.
pub struct Prepared {
    pub model_b64: String,
    pub thumb_data_url: String,
}

fn jpeg_b64(img: &DynamicImage, max_side: u32, quality: u8) -> anyhow::Result<String> {
    let rgb = img.thumbnail(max_side, max_side).to_rgb8();
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, quality)
        .encode(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
        .context("encoding JPEG")?;
    Ok(B64.encode(out))
}

pub fn prepare(jpeg: &[u8]) -> anyhow::Result<Prepared> {
    let img = decode(jpeg)?;
    Ok(Prepared {
        model_b64: jpeg_b64(&img, 768, 80)?,
        thumb_data_url: format!("data:image/jpeg;base64,{}", jpeg_b64(&img, 200, 70)?),
    })
}

/// Words that suggest an utterance is about where something is or a hazard.
/// A plain word list keeps this free; a model call on every tick would be too slow.
const KEYWORDS: &[&str] = &[
    "put", "putting", "left", "leave", "leaving", "moved", "moving", "placed", "keep", "kept", "keys", "wallet",
    "phone", "glasses", "passport", "charger", "bag", "pills", "medication", "medicine", "tablets", "kettle", "door",
    "stairs", "step", "steps", "drawer", "cupboard", "cabinet", "shelf", "counter", "table", "pocket", "fridge",
    "floor", "wet", "careful", "watch", "blocked", "spilled", "open",
];

/// Questions and commands belong to the query path, not to memory.
/// Speech-to-text often drops the question mark, so the first word decides.
const NOT_A_NOTE: &[&str] = &[
    "where", "what", "which", "who", "how", "when", "why", "guide", "help", "find", "forget", "clear", "can", "could",
    "would", "will", "please", "do", "does", "did", "is", "are", "tell", "show", "take", "bring",
];

pub fn is_note(text: &str) -> bool {
    let lower = text.to_lowercase();
    if lower.trim_end().ends_with('?') {
        return false;
    }
    let mut words = lower.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty());
    let Some(first) = words.next() else { return false };
    if NOT_A_NOTE.contains(&first) {
        return false;
    }
    std::iter::once(first).chain(words).any(|w| KEYWORDS.contains(&w))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn jpeg(f: impl Fn(u32, u32) -> u8) -> Vec<u8> {
        let img = RgbImage::from_fn(320, 240, |x, y| {
            let v = f(x, y);
            Rgb([v, v, v])
        });
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, 90).encode(img.as_raw(), 320, 240, ExtendedColorType::Rgb8).unwrap();
        out
    }

    #[test]
    fn same_view_hashes_alike_and_different_view_does_not() {
        let left_to_right = analyse(&jpeg(|x, _| (x * 255 / 320) as u8)).unwrap();
        let slightly_darker = analyse(&jpeg(|x, _| (x * 240 / 320) as u8)).unwrap();
        let right_to_left = analyse(&jpeg(|x, _| 255 - (x * 255 / 320) as u8)).unwrap();
        assert!(distance(left_to_right.hash, slightly_darker.hash) <= 4);
        assert!(distance(left_to_right.hash, right_to_left.hash) > 30);
    }

    #[test]
    fn detailed_frame_is_sharper_than_flat_one() {
        let flat = analyse(&jpeg(|_, _| 128)).unwrap();
        let checks = analyse(&jpeg(|x, y| if (x / 8 + y / 8) % 2 == 0 { 30 } else { 220 })).unwrap();
        assert!(checks.sharpness > flat.sharpness * 10.0 + 1.0);
    }

    #[test]
    fn prepare_makes_small_copies() {
        let p = prepare(&jpeg(|x, _| (x % 255) as u8)).unwrap();
        assert!(p.thumb_data_url.starts_with("data:image/jpeg;base64,"));
        assert!(p.thumb_data_url.len() < p.model_b64.len() + 30);
    }

    #[test]
    fn notes_trigger_but_questions_and_chatter_do_not() {
        assert!(is_note("Putting my keys in my left coat pocket"));
        assert!(is_note("Careful, single step down into the garage"));
        assert!(is_note("I put your new pills in the top cupboard."));
        assert!(!is_note("Where did I leave my keys?"));
        assert!(!is_note("Guide me to the kettle"));
        assert!(!is_note("Forget my wallet"));
        assert!(!is_note("Can you find my keys"));
        assert!(!is_note("Please guide me to the door"));
        assert!(!is_note("Is the floor wet"));
        assert!(!is_note("Nice weather today"));
        assert!(!is_note(""));
    }
}
