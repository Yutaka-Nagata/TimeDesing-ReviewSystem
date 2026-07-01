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

function formatTasks(tasks) {
  if (tasks.length === 0) return '（記録なし）';
  return tasks
    .map(t => `  ${t.start_time} ${t.title}（${t.estimated_minutes}分）${t.is_done ? '✓' : ''}`)
    .join('\n');
}

async function buildReviewPrompt(yesterday, tasks, weekTasks = null, monthTasks = null) {
  const today = new Date(yesterday);
  today.setDate(today.getDate() + 1);
  const todayStr = today.toISOString().split('T')[0];

  let prompt = `あなたはユーザーの生活習慣をレビューするアシスタントです。
以下の「理想の生活」と「実際の記録」を比較し、日本語でレビューを作成してください。

# 理想の生活
${IDEAL_LIFE}

---

# ${yesterday}（昨日）の記録
${formatTasks(tasks)}

`;

  if (weekTasks) {
    const weekStr = `${getDateStr(7)} 〜 ${yesterday}`;
    prompt += `---

# 週次レビュー（${weekStr}）
${formatTasks(weekTasks)}

`;
  }

  if (monthTasks) {
    const monthStr = `${getDateStr(30)} 〜 ${yesterday}`;
    prompt += `---

# 月次レビュー（${monthStr}）
${formatTasks(monthTasks)}

`;
  }

  prompt += `---

# 指示
以下の構成でレビューを作成してください。簡潔に、でも具体的に。

## 昨日のサマリー
- 就寝・起床時刻（睡眠タスクから読み取る）
- 主な活動
- 理想との主なズレ（あれば）

## よかった点

## 改善できる点

`;

  if (weekTasks) prompt += `## 今週の傾向\n\n`;
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
const yesterday = getDateStr(1);
const todayStr = getDateStr(0);

console.log(`レビュー対象: ${yesterday}`);

const tasks = await fetchTasks(yesterday);
let weekTasks = null;
let monthTasks = null;

if (isSunday(todayStr)) {
  weekTasks = await fetchTasks(getDateStr(7), yesterday);
}
if (isFirstSundayOfMonth(todayStr)) {
  monthTasks = await fetchTasks(getDateStr(30), yesterday);
}

const prompt = await buildReviewPrompt(yesterday, tasks, weekTasks, monthTasks);
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
