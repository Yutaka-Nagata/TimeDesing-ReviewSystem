// 接続テスト：Supabase から昨日のタスクを取得し、Resend でメールを送る
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL = process.env.TO_EMAIL;

// 昨日の日付（YYYY-MM-DD）
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const dateStr = yesterday.toISOString().split('T')[0];

console.log(`テスト対象日: ${dateStr}`);

// Supabase からタスク取得
const res = await fetch(
  `${SUPABASE_URL}/rest/v1/tasks?date=eq.${dateStr}&select=*&order=start_time.asc`,
  {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  }
);

if (!res.ok) {
  console.error('Supabase エラー:', res.status, await res.text());
  process.exit(1);
}

const tasks = await res.json();
console.log(`取得タスク数: ${tasks.length}`);
console.log(JSON.stringify(tasks.slice(0, 3), null, 2));

// Resend でテストメール送信
const mailRes = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${RESEND_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    from: 'Life Review <onboarding@resend.dev>',
    to: TO_EMAIL,
    subject: `[テスト] Life Review 接続確認`,
    text: `接続テスト成功。\n\n${dateStr} のタスク数: ${tasks.length}件`,
  }),
});

if (!mailRes.ok) {
  console.error('Resend エラー:', mailRes.status, await mailRes.text());
  process.exit(1);
}

const mail = await mailRes.json();
console.log('メール送信成功:', mail.id);
