// Baseline + delta sampler for WorkBuddy credit calibration.
// Records (timestamp, balance total, credit map) so a later run can compute
// how many credits one assistant step really costs.
const fs = require('node:fs');

const SESSION = 'session-8be6bd49-e4f4-4efd-928a-f2cbbfaf05f1';
const OUT = process.argv[2] ?? 'E:/工作区/dsh-patches/workbuddy-bridge-patch/calibration.jsonl';

async function main() {
  const status = await fetch('http://127.0.0.1:64905/plugins/dsh-workbuddy-bridge/status', {
    headers: { accept: 'application/json', Origin: 'http://127.0.0.1:64905' },
  }).then((r) => r.json());
  const credit = await fetch(
    `http://127.0.0.1:64905/plugins/dsh-workbuddy-bridge/credit?sessionId=${SESSION}`,
    { headers: { accept: 'application/json', Origin: 'http://127.0.0.1:64905' } },
  ).then((r) => r.json());

  const models = Object.fromEntries((status.models ?? []).map((m) => [m.id, m.credits]));
  const row = {
    at: Date.now(),
    total: status.credits?.total,
    accounts: status.credits?.accounts,
    models,
    credits: credit.credits ?? {},
  };
  fs.appendFileSync(OUT, `${JSON.stringify(row)}\n`, 'utf8');
  console.log(JSON.stringify({ at: row.at, total: row.total, entries: Object.keys(row.credits).length }));
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
