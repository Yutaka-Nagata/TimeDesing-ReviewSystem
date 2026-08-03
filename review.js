import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL = process.env.TO_EMAIL;
const USER_ID = 'da0d7d64-124a-4f80-b8b0-a2a967a7296c';

const IDEAL_LIFE = readFileSync(join(__dirname, 'ideal-life.md'), 'utf-8');

function getDateStr(daysAgo) {
  const d = new Date();
  d.setTime(d.getTime() + 9 * 60 * 60 * 1000); // UTC→JST
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

// --- 日時ユーティリティ（タイムゾーン非依存の「分」通し番号で扱う） ---
// tasks.date は 'YYYY-MM-DD'、start_time は 'HH:MM'。両者を絶対分に変換して計算する。

function dayIndex(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function shiftDate(dateStr, days) {
  return new Date((dayIndex(dateStr) + days) * 86400000).toISOString().split('T')[0];
}

function toAbsMinutes(dateStr, timeStr) {
  const [h, mi] = timeStr.split(':').map(Number);
  return dayIndex(dateStr) * 1440 + h * 60 + mi;
}

function fromAbsMinutes(abs) {
  const di = Math.floor(abs / 1440);
  const min = abs - di * 1440;
  const date = new Date(di * 86400000).toISOString().split('T')[0];
  const time = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  return { date, time };
}

function formatDuration(minutes) {
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

const SLEEP_RE = /睡眠|仮眠|昼寝/;

// 睡眠タスクを「就寝〜起床」の区間に変換する。起床日は終了時刻の日付。
function toSleepBlocks(tasks) {
  return tasks
    .filter(t => SLEEP_RE.test(t.title))
    .map(t => {
      const startAbs = toAbsMinutes(t.date, t.start_time);
      const minutes = t.estimated_minutes;
      const endAbs = startAbs + minutes;
      return {
        startAbs,
        endAbs,
        minutes,
        start: fromAbsMinutes(startAbs),
        end: fromAbsMinutes(endAbs),
        memo: t.memo,
      };
    })
    .sort((a, b) => a.startAbs - b.startAbs);
}

function describeBlock(b) {
  const sameDay = b.start.date === b.end.date;
  return `就寝 ${b.start.date} ${b.start.time} → 起床 ${sameDay ? '' : b.end.date + ' '}${b.end.time}（${formatDuration(b.minutes)}）`;
}

// 対象日 D の睡眠を確定計算する。
// 主睡眠 = D に起床した睡眠ブロックのうち最長のもの（日またぎ・夜更かしの両方をこれで拾える）。
function buildSleepSection(targetDate, blocks) {
  const wokeOnTarget = blocks.filter(b => b.end.date === targetDate);
  const main = wokeOnTarget.reduce((a, b) => (!a || b.minutes > a.minutes ? b : a), null);
  const naps = wokeOnTarget.filter(b => b !== main);
  // D の夜に寝て翌日に起きた睡眠（＝Dの締めくくり）
  const nightOfTarget = blocks.find(b => b.start.date === targetDate && b.end.date !== targetDate);
  // D 中に寝ていない場合、翌日の未明〜午前に始まった睡眠が「D の夜更かしの果て」にあたる
  const nextDate = shiftDate(targetDate, 1);
  const overnight = nightOfTarget
    ? null
    : blocks.find(b => b.start.date === nextDate && b.startAbs % 1440 < 11 * 60);

  let s = `# 睡眠（システムが確定計算した値。この数値をそのまま使うこと。再計算・推測は禁止）\n\n`;
  s += `## ${targetDate} の睡眠（起床日基準）\n`;
  if (main) {
    s += `- ${describeBlock(main)}\n`;
    const flags = [];
    const bedMin = main.startAbs % 1440;
    const wakeMin = main.endAbs % 1440;
    if (main.start.date !== main.end.date) flags.push('日をまたいで就寝');
    if (bedMin < 4 * 60) flags.push(`深夜就寝（${main.start.time}）`);
    else if (bedMin < 8 * 60) flags.push(`明け方就寝（${main.start.time}）`);
    if (wakeMin >= 12 * 60) flags.push(`起床が正午以降（${main.end.time}）＝昼夜逆転`);
    if (main.minutes >= 600) flags.push(`睡眠が10時間超（${formatDuration(main.minutes)}）`);
    if (main.minutes <= 300) flags.push(`睡眠が5時間以下（${formatDuration(main.minutes)}）`);
    if (flags.length) s += `- 判定: ${flags.join(' / ')}\n`;
  } else {
    s += `- 記録なし（${targetDate} に起床した睡眠タスクが見つからない。未入力の可能性が高い。就寝・起床時刻を推測で書かないこと）\n`;
  }
  if (naps.length) {
    s += `- 同日のその他の睡眠: ${naps.map(describeBlock).join(' / ')}\n`;
  }

  s += `\n## ${targetDate} の夜の就寝（翌日への締めくくり）\n`;
  if (nightOfTarget) {
    s += `- ${describeBlock(nightOfTarget)}\n`;
  } else if (overnight) {
    const past = overnight.startAbs % 1440;
    s += `- 日付をまたいで夜更かし：${overnight.start.date} ${overnight.start.time} に就寝（${targetDate} の24時から${formatDuration(past)}オーバー）\n`;
    s += `- ${describeBlock(overnight)}\n`;
  } else {
    s += `- 記録なし（${targetDate} の夜に始まる睡眠タスクが見つからない。未入力の可能性）\n`;
  }

  if (blocks.length) {
    s += `\n## 参考：取得範囲内の全睡眠ブロック\n`;
    s += blocks.map(b => `- ${describeBlock(b)}${b.memo ? `　※${b.memo}` : ''}`).join('\n') + '\n';
  }
  return s;
}

// 週次用：就寝・起床の位相ドリフトをテキストチャートで可視化する。
// 横軸は「前日18時 → 当日18時」の24時間窓。ブロックが右にずれていくほど夜型に流れている。
function buildSleepTrend(fromDate, toDate, blocks) {
  const WIDTH = 24;
  let s = `# 就寝・起床の推移（位相ドリフト）\n`;
  s += `横軸は前日18時から当日18時までの24時間。█ が睡眠帯。右にずれるほど夜型に後退している。\n\n`;
  s += `             18 21 00 03 06 09 12 15\n`;

  let prevOffset = null;
  const drifts = [];
  const offsets = [];
  for (let di = dayIndex(fromDate); di <= dayIndex(toDate); di++) {
    const date = new Date(di * 86400000).toISOString().split('T')[0];
    const woke = blocks.filter(b => b.end.date === date);
    const main = woke.reduce((a, b) => (!a || b.minutes > a.minutes ? b : a), null);
    const wd = '日月火水木金土'[new Date(date + 'T00:00:00Z').getUTCDay()];
    const label = `${date.slice(5)}(${wd})`;

    if (!main) {
      s += `${label} ${'·'.repeat(WIDTH)}  記録なし\n`;
      continue;
    }
    const winStart = (di - 1) * 1440 + 18 * 60;
    const cells = Array(WIDTH).fill('·');
    for (let h = 0; h < WIDTH; h++) {
      const cellStart = winStart + h * 60;
      if (cellStart + 60 > main.startAbs && cellStart < main.endAbs) cells[h] = '█';
    }
    const offset = main.startAbs - winStart; // 前日18時からの経過分
    offsets.push({ offset, time: main.start.time });
    let driftLabel = '';
    if (prevOffset !== null) {
      const drift = offset - prevOffset;
      drifts.push(drift);
      const sign = drift >= 0 ? '+' : '−';
      driftLabel = `  前日比 ${sign}${formatDuration(Math.abs(drift))}`;
    }
    prevOffset = offset;
    s += `${label} ${cells.join('')}  就寝${main.start.time} 起床${main.end.time} ${formatDuration(main.minutes)}${driftLabel}\n`;
  }

  if (drifts.length) {
    const total = drifts.reduce((a, b) => a + b, 0);
    const avg = Math.round(total / drifts.length);
    s += `\n- 平均ドリフト: 1日あたり ${avg >= 0 ? '+' : '−'}${formatDuration(Math.abs(avg))}\n`;
    s += `- 期間全体の位相移動: ${total >= 0 ? '+' : '−'}${formatDuration(Math.abs(total))}（プラスは夜型への後退）\n`;
    s += `- 後退した日: ${drifts.filter(d => d > 0).length}日 / 前倒しできた日: ${drifts.filter(d => d < 0).length}日\n`;

    // 平均ドリフトは前進と後退が打ち消し合うため、振れ幅で型を判定する
    const sorted = [...offsets].sort((a, b) => a.offset - b.offset);
    const spread = sorted[sorted.length - 1].offset - sorted[0].offset;
    const swing = Math.round(drifts.reduce((a, d) => a + Math.abs(d), 0) / drifts.length);
    s += `- 就寝時刻の振れ幅: ${sorted[0].time} 〜 ${sorted[sorted.length - 1].time}（${formatDuration(spread)}の幅）\n`;
    s += `- 1日あたりの平均的なブレ幅（絶対値）: ${formatDuration(swing)}\n`;

    let type;
    if (spread >= 240)
      type = '【不規則型】就寝時刻が日によってバラバラ。一定方向に流れているのではなく、毎日リセットが効いていない状態。まず「毎日同じ時刻に起きる」ことだけに絞るべき。';
    else if (avg >= 20)
      type = '【後退型】就寝時刻が毎日じわじわ後ろにずれている。体内時計が自由に走っている状態なので、朝の固定アンカー（同じ時刻に光を浴びる予定）が必要。';
    else if (avg <= -20) type = '【前倒し型】位相が前に戻ってきている。この流れを崩さないことが最優先。';
    else type = '【安定型】位相はほぼ一定。あとは全体を何時にずらすかの問題。';
    s += `- 判定: ${type}\n`;
  }
  return s;
}

function isFirstSundayOfMonth(date) {
  const d = new Date(date);
  return d.getDay() === 0 && d.getDate() <= 7;
}

function isSunday(date) {
  return new Date(date).getDay() === 0;
}

async function fetchTasks(dateFrom, dateTo) {
  const url = dateTo
    ? `${SUPABASE_URL}/rest/v1/tasks?date=gte.${dateFrom}&date=lte.${dateTo}&user_id=eq.${USER_ID}&select=*&order=date.asc,start_time.asc`
    : `${SUPABASE_URL}/rest/v1/tasks?date=eq.${dateFrom}&user_id=eq.${USER_ID}&select=*&order=start_time.asc`;

  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase error: ${res.status} ${await res.text()}`);
  return res.json();
}

function formatTasks(tasks, withDate = false) {
  if (tasks.length === 0) return '（記録なし）';
  return tasks
    .map(t => {
      const startAbs = toAbsMinutes(t.date, t.start_time);
      const end = fromAbsMinutes(startAbs + t.estimated_minutes);
      const endLabel = end.date === t.date ? end.time : `翌${end.time}`;
      const prefix = withDate ? `  ${t.date} ` : '  ';
      return `${prefix}${t.start_time}-${endLabel} ${t.title}（${t.estimated_minutes}分）${t.is_done ? '✓' : ''}${t.memo ? `　※${t.memo}` : ''}`;
    })
    .join('\n');
}

async function buildReviewPrompt(yesterday, tasks, sleepSection, weekTasks = null, monthTasks = null, sleepTrend = null) {
  let prompt = `あなたはユーザーの生活習慣をレビューするアシスタントです。
以下の「理想の生活」と「実際の記録」を比較し、日本語でレビューを作成してください。

# 理想の生活
${IDEAL_LIFE}

---

${sleepSection}
---

# ${yesterday}（昨日）の記録
${formatTasks(tasks)}

`;

  if (weekTasks) {
    const weekStr = `${shiftDate(yesterday, -6)} 〜 ${yesterday}`;
    prompt += `---

${sleepTrend ?? ''}
---

# 週次レビュー（${weekStr}）
${formatTasks(weekTasks, true)}

`;
  }

  if (monthTasks) {
    const monthStr = `${shiftDate(yesterday, -29)} 〜 ${yesterday}`;
    prompt += `---

# 月次レビュー（${monthStr}）
${formatTasks(monthTasks, true)}

`;
  }

  prompt += `---

# 指示
以下の構成でレビューを作成してください。簡潔に、でも具体的に。

## 昨日のサマリー
- 就寝・起床時刻・睡眠時間：上の「睡眠」セクションの確定値をそのまま転記する。
  タスク一覧から自分で読み取ったり計算し直したりしてはいけない。
  「記録なし」と書かれている場合は「記録なし」と書き、時刻を推測しない。
- 主な活動
- 理想との主なズレ（あれば）

## よかった点

## 改善できる点

`;

    if (weekTasks) {
    prompt += `## 今週の傾向
「就寝・起床の推移」セクションの【判定】を最初に述べ、その根拠となる数値
（不規則型なら振れ幅、後退型なら平均ドリフト）を引用すること。
平均ドリフトは前進と後退が打ち消し合うため、不規則型のときに「ほぼ横ばい」とまとめてはいけない。
そのうえで「明日は昨日の起床時刻より15〜30分だけ早く起きる」という小刻みな一手を提示する。
理想の6時起床との差分を並べて責める書き方はしない。

`;
  }
  if (monthTasks) prompt += `## 今月の傾向\n\n`;

  prompt += `## 明日へのひとこと（短く）
`;

  return prompt;
}

async function analyzeWithClaude(prompt) {
  // Claude API でレビュー生成
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text;
}

async function sendEmail(subject, body) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Life Review <onboarding@resend.dev>',
      to: TO_EMAIL,
      subject,
      text: body,
    }),
  });
  if (!res.ok) throw new Error(`Resend error: ${res.status} ${await res.text()}`);
  return res.json();
}

// --- main ---
// 引数: --dry-run（Claude API・メール送信をスキップしてプロンプトを表示）
//       YYYY-MM-DD（対象日を明示指定。デフォルトは昨日）
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const yesterday = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? getDateStr(1);
const todayStr = shiftDate(yesterday, 1);

console.log(`レビュー対象: ${yesterday}${DRY_RUN ? '（dry-run）' : ''}`);

// 睡眠は日をまたぐため、前後の日も含めて取得してから対象日を切り出す
const windowTasks = await fetchTasks(shiftDate(yesterday, -2), todayStr);
const tasks = windowTasks.filter(t => t.date === yesterday);
const sleepSection = buildSleepSection(yesterday, toSleepBlocks(windowTasks));

let weekTasks = null;
let monthTasks = null;

let sleepTrend = null;

if (isSunday(todayStr)) {
  // 週の初日の睡眠は前日夜に始まっているため、1日多めに取ってブロックを組む
  const weekFrom = shiftDate(yesterday, -6);
  const weekWindow = await fetchTasks(shiftDate(weekFrom, -1), yesterday);
  weekTasks = weekWindow.filter(t => t.date >= weekFrom);
  sleepTrend = buildSleepTrend(weekFrom, yesterday, toSleepBlocks(weekWindow));
}
if (isFirstSundayOfMonth(todayStr)) {
  monthTasks = await fetchTasks(shiftDate(yesterday, -29), yesterday);
}

const prompt = await buildReviewPrompt(yesterday, tasks, sleepSection, weekTasks, monthTasks, sleepTrend);

if (DRY_RUN) {
  console.log('\n--- プロンプト ---\n' + prompt);
  process.exit(0);
}

const review = await analyzeWithClaude(prompt);

const isWeekly = isSunday(todayStr);
const isMonthly = isFirstSundayOfMonth(todayStr);
const subject = isMonthly
  ? `📅 月次レビュー ${yesterday}`
  : isWeekly
  ? `📅 週次レビュー ${yesterday}`
  : `☀️ Daily Review ${yesterday}`;

const result = await sendEmail(subject, review);
console.log('送信完了:', result.id);
console.log('\n--- レビュー内容 ---\n', review);
