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

// 就寝・起床を「前日18時からの経過分」に正規化する。日をまたぐ値を素直に比較するため。
function phaseOffsets(date, main) {
  const base = (dayIndex(date) - 1) * 1440 + 18 * 60;
  return { bed: main.startAbs - base, wake: main.endAbs - base };
}

function offsetToClock(offset) {
  const m = (((offset + 18 * 60) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function mainSleepOf(date, blocks) {
  return blocks.filter(b => b.end.date === date).reduce((a, b) => (!a || b.minutes > a.minutes ? b : a), null);
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

// 評価の基準線。理想（22時就寝・6時起床）ではなく直近7日の中央値と比べる。
// 固定の理想と毎日比べると、実際に前進していても常に「未達」と記録され、
// 修正行動そのものが続かなくなるため。基準は毎日勝手に移動する。
function buildBaselineSection(targetDate, blocks) {
  const todayMain = mainSleepOf(targetDate, blocks);

  const past = [];
  for (let k = 7; k >= 1; k--) {
    const date = shiftDate(targetDate, -k);
    const main = mainSleepOf(date, blocks);
    if (main) past.push({ date, ...phaseOffsets(date, main), minutes: main.minutes });
  }

  let s = `# 評価の基準線（直近7日の中央値。理想の時刻とは比べないこと）\n\n`;

  if (past.length < 3) {
    s += `- 比較できる日が${past.length}日分しかないため、今回は基準線を使わない。\n\n`;
    return s;
  }

  const bedMed = median(past.map(p => p.bed));
  const wakeMed = median(past.map(p => p.wake));
  s += `- 直近${past.length}日の中央値：就寝 ${offsetToClock(bedMed)} ／ 起床 ${offsetToClock(wakeMed)}\n`;

  if (!todayMain) {
    s += `- ${targetDate} は睡眠の記録がないため比較できない。\n\n`;
    return s;
  }

  const cur = phaseOffsets(targetDate, todayMain);
  const bedDiff = cur.bed - bedMed;
  const wakeDiff = cur.wake - wakeMed;
  const judge = (diff, label) =>
    diff <= -30
      ? `**${label}は基準線より ${formatDuration(-diff)} 前倒しできている（勝ち）**`
      : diff >= 30
        ? `${label}は基準線より ${formatDuration(diff)} 後退している`
        : `${label}は基準線とほぼ同じ（横ばい）`;
  s += `- ${targetDate}：就寝 ${offsetToClock(cur.bed)} ／ 起床 ${offsetToClock(cur.wake)}\n`;
  s += `- 判定：${judge(bedDiff, '就寝')}／${judge(wakeDiff, '起床')}\n`;

  // 前倒しストリーク：前日より就寝が早くなった日が何日続いているか
  let streak = 0;
  for (let k = 0; k < 14; k++) {
    const d = shiftDate(targetDate, -k);
    const prev = shiftDate(targetDate, -k - 1);
    const a = mainSleepOf(d, blocks);
    const b = mainSleepOf(prev, blocks);
    if (!a || !b) break;
    if (phaseOffsets(d, a).bed < phaseOffsets(prev, b).bed) streak++;
    else break;
  }
  s += `- 前倒しストリーク：${streak}日連続${streak >= 2 ? '（この継続自体を勝ちとして扱うこと）' : ''}\n`;

  s += `
## この基準線の使い方（重要）
- 本人は睡眠相後退症候群（DSPS）の診断を受けている。位相を前に戻す作業は、
  健常者が無コストで維持している状態への「回復」ではなく、**能動的な努力で買う達成**である。
  0からプラスへ積み上げる作業として扱い、達成として褒めること。
- 人間の体内時計は前倒し方向には**1日30分〜1時間**しか動かない。これは生理的な上限であり、
  努力で超えられない。したがって1日30分の前倒しは小さな改善ではなく、**上限に近い速度**である。
- 日次レビューでは「22時就寝・6時起床」という理想の時刻に**言及しない**。
  比較対象は上の基準線のみ。理想との距離は週次レビューでのみ扱う。
- 「まだ理想に届いていない」という趣旨の文を日次で書かない。前進していれば前進と書く。

`;
  return s;
}

// 直近4日から「崩れ始め」を検知する。DSPSでは自力復元が効かないため、
// 大きく崩れてからではなく後退の初期段階で警告を出すことを目的とする。
function buildSleepAlert(targetDate, blocks) {
  const days = [];
  for (let k = 3; k >= 0; k--) {
    const date = shiftDate(targetDate, -k);
    days.push({ date, main: mainSleepOf(date, blocks) });
  }

  const offsets = days.map(d => (d.main ? phaseOffsets(d.date, d.main).bed : null));
  const drifts = [];
  for (let i = 1; i < offsets.length; i++) {
    drifts.push(offsets[i] !== null && offsets[i - 1] !== null ? offsets[i] - offsets[i - 1] : null);
  }

  const alerts = [];
  const last3 = drifts.slice(-3);
  if (last3.length === 3 && last3.every(d => d !== null && d > 0)) {
    const total = last3.reduce((a, b) => a + b, 0);
    alerts.push(
      `⚠️ 位相ドリフト警告：3日連続で就寝が後退している（合計 ${formatDuration(total)}）。` +
        `本人はDSPSの診断を受けており、健常者と違って放置しても自然には戻らない。` +
        `「気をつけよう」ではなく、今日中に起床時刻を固定するという具体的な一手を書くこと。`
    );
  }

  const lastTwo = days.slice(-2).map(d => d.main);
  if (lastTwo.length === 2 && lastTwo.every(m => m && m.endAbs % 1440 >= 12 * 60)) {
    alerts.push(
      `🚨 復旧プロトコル発火：起床が正午以降の日が2日続いた。` +
        `通常の改善フィードバックは書かず、「理想の生活」の復旧プロトコルの手順をそのまま提示することを最優先にする。` +
        `理想との差分を並べて責めない。崩れている最中の本人は気力が落ちているので、ハードルを下げる方向で書く。`
    );
  }

  const lastDrift = drifts[drifts.length - 1];
  if (lastDrift !== null && lastDrift <= -30) {
    alerts.push(
      `✅ 前進：前日より就寝が ${formatDuration(-lastDrift)} 前倒しできている。` +
        `この事実をレビューの冒頭ではっきり褒めること。理想（22時就寝）との差分には触れない。` +
        `体内時計は前倒し方向に1日30分〜1時間しか動かないため、この幅は生理的な上限に近い。` +
        `本人は前進を「目標未達」として記録してしまう癖があるため、ここを正しく勝ちとして扱うこと自体が重要。`
    );
  }

  return alerts.length ? `# 睡眠アラート（最優先で扱うこと）\n${alerts.map(a => `- ${a}`).join('\n')}\n\n` : '';
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

async function buildReviewPrompt(yesterday, tasks, sleepSection, weekTasks = null, monthTasks = null, sleepTrend = null, sleepAlert = '', baseline = '') {
  let prompt = `あなたはユーザーの生活習慣をレビューするアシスタントです。
以下の「理想の生活」と「実際の記録」を比較し、日本語でレビューを作成してください。

${sleepAlert}# 理想の生活
${IDEAL_LIFE}

---

${sleepSection}
---

${baseline}---

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
- 睡眠の評価は「評価の基準線」セクションの直近7日中央値との比較だけで行う。
  **日次レビューでは理想の就寝・起床時刻（22時／6時）に一切言及しない。**
  「理想には届いていない」「まだ遅い」といった、固定の理想を基準にした表現も使わない。
- 主な活動
- 睡眠以外（学習時間・漫画キャプチャ作業・悪習慣）については、
  従来どおり「理想の生活」と比較してズレを指摘してよい。制限がかかるのは睡眠だけ。

## よかった点

## 改善できる点

`;

    if (weekTasks) {
    prompt += `## 今週の傾向
「就寝・起床の推移」セクションの【判定】を最初に述べ、その根拠となる数値
（不規則型なら振れ幅、後退型なら平均ドリフト）を引用すること。
平均ドリフトは前進と後退が打ち消し合うため、不規則型のときに「ほぼ横ばい」とまとめてはいけない。
そのうえで「明日は昨日の起床時刻より15〜30分だけ早く起きる」という小刻みな一手を提示する。

理想（22時就寝・6時起床）との距離に触れてよいのは、週次レビューのこの節だけである。
その際も「あと何時間足りない」ではなく「今のペースならどれくらいで届くか」という書き方にする。
体内時計は前倒し方向に1日30分〜1時間しか動かないので、残り時間から所要日数を計算して示すこと。

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
// 崩れ検知に4日分の睡眠が要るため、余裕を持って5日前から取得する
const windowTasks = await fetchTasks(shiftDate(yesterday, -9), todayStr);
const tasks = windowTasks.filter(t => t.date === yesterday);
const blocks = toSleepBlocks(windowTasks);
const sleepSection = buildSleepSection(yesterday, blocks.filter(b => b.end.date >= shiftDate(yesterday, -2)));
const sleepAlert = buildSleepAlert(yesterday, blocks);
const baseline = buildBaselineSection(yesterday, blocks);

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

const prompt = await buildReviewPrompt(yesterday, tasks, sleepSection, weekTasks, monthTasks, sleepTrend, sleepAlert, baseline);

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
