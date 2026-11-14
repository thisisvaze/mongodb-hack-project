import { KIND_LABEL, labelOf } from '../format';
import type { TurnResponse } from '../types';

export interface TurnResult {
  userName: string;
  text: string;
  sentImage: boolean;
  response?: TurnResponse;
  error?: string;
}

interface Props {
  result: TurnResult | null;
  pending: boolean;
  /** Shown before the first turn. */
  hint: string;
}

/** The last turn: what was said, the kind of reply, and the reply text. */
export function ReplyPanel({ result, pending, hint }: Props) {
  const kind = result?.response?.kind;
  const tone = result?.error || kind === 'denied' ? 'bad' : kind === 'ignored' ? 'quiet' : 'good';

  return (
    <div className={`reply ${result ? tone : 'empty'}`} aria-live="polite" aria-atomic="true">
      {!result && <p className="reply-hint">{pending ? 'Sending…' : hint}</p>}
      {result && (
        <>
          <p className="reply-said">
            <span className="reply-who">{result.userName}:</span> “{result.text}”
            {result.sentImage && <span className="reply-note"> with a camera frame</span>}
            {pending && <span className="reply-note"> · sending the next turn…</span>}
          </p>
          {result.response && (
            <p className="reply-line">
              <span className={`tag kind-${result.response.kind}`}>{labelOf(KIND_LABEL, result.response.kind)}</span>
              <span className="reply-text">{result.response.reply_text}</span>
            </p>
          )}
          {result.error && (
            <p className="reply-line">
              <span className="tag kind-error">Error</span>
              <span className="reply-text">{result.error}</span>
            </p>
          )}
        </>
      )}
    </div>
  );
}
