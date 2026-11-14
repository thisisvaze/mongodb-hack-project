// The scorecard in MongoDB:
//   guardrail_cases   one document per attack case (cases.js), editable in Atlas
//   guardrail_runs    one document per run: totals, per-category counts, every result

export async function seedCases(collection, cases) {
  const ops = cases.map((c, order) => ({
    replaceOne: { filter: { _id: c._id }, replacement: { ...c, order, updated_at: new Date() }, upsert: true },
  }));
  const out = await collection.bulkWrite(ops, { ordered: false });
  return { upserted: out.upsertedCount, updated: out.modifiedCount };
}

// Cases in their stored order; cases added in Atlas without `order` come last.
export async function loadCases(collection) {
  const cases = await collection.find({ disabled: { $ne: true } }).toArray();
  return cases.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || String(a._id).localeCompare(String(b._id)));
}

export async function saveRun(collection, run) {
  await collection.insertOne(run);
  return run._id;
}

export async function recentRuns(collection, limit = 10) {
  return collection
    .find({}, { projection: { results: 0 } })
    .sort({ started_at: -1 })
    .limit(limit)
    .toArray();
}
