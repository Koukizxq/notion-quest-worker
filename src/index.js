// index.js — Cloudflare Worker for Quest Automation

export default {
  async scheduled(event, env, ctx) {
    const now = new Date();
    const ukTime = new Date(now.toLocaleString("en-GB", { timeZone: "Europe/London" }));
    const hourUK = ukTime.getHours();

    // Quest Reset: 00:00 UK (23:00 UTC in winter, but we use cron=0 * * * * and filter here)
    if (event.cron === "0 * * * *" && hourUK === 0) {
      console.log("▶️ Running Quest Reset");
      await resetDailyTracker(env);
    }

    // Quest Scheduler: 09:00 UK
    if (event.cron === "0 * * * *" && hourUK === 9) {
      console.log("▶️ Running Quest Scheduler");
      await dailyQuestScheduler(env);
    }

    // Quest Log: every hour from 10AM UK onwards
    if (event.cron === "0 * * * *" && hourUK >= 10) {
      console.log(`▶️ Running Quest Log at ${hourUK}:00 UK`);
      await questLog(env);
    }
  },
};

/* =======================
   CONFIG + HELPERS
======================= */
const NOTION_TOKEN = globalThis.NOTION_API_KEY; // set in Cloudflare env var
const HEADERS = {
  "Authorization": `Bearer ${NOTION_TOKEN}`,
  "Notion-Version": "2025-09-03",
  "Content-Type": "application/json",
};

// Replace with your Notion IDs
const DAILY_TRACKER_DS = "26cad899-3405-8000-a848-000b2832e1fa";
const QUEST_MASTER_DS = "26cad899-3405-8075-a6a3-000b6573262f";
const QUEST_LOG_DS     = "26cad899-3405-80d1-9925-000b49edaef1";

const NUM_DAILY_QUESTS = 5;
const COOLDOWN_DAYS = 3;

async function notionPost(url, body) {
  const res = await fetch(url, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Notion POST failed: ${res.status}`);
  return res.json();
}
async function notionPatch(url, body) {
  const res = await fetch(url, { method: "PATCH", headers: HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Notion PATCH failed: ${res.status}`);
  return res.json();
}
async function notionGet(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Notion GET failed: ${res.status}`);
  return res.json();
}

/* =======================
   QUEST RESET
======================= */
async function resetDailyTracker(env) {
  const url = `https://api.notion.com/v1/data_sources/${DAILY_TRACKER_DS}/query`;
  const data = await notionPost(url, {});
  const quests = data.results || [];

  if (!quests.length) {
    console.log("✅ Daily Quest Tracker already empty.");
    return;
  }

  for (const quest of quests) {
    try {
      await notionPatch(`https://api.notion.com/v1/pages/${quest.id}`, { archived: true });
    } catch (err) {
      console.log(`❌ Failed to archive ${quest.id}: ${err}`);
    }
  }

  console.log("✅ Daily Quest Tracker reset.");
}

/* =======================
   QUEST SCHEDULER
======================= */
async function dailyQuestScheduler(env) {
  console.log("Fetching quests from Quest Master...");
  const url = `https://api.notion.com/v1/data_sources/${QUEST_MASTER_DS}/query`;
  const data = await notionPost(url, {});
  const quests = (data.results || []).map(parseQuest);

  if (!quests.length) {
    console.log("❌ No quests found.");
    return;
  }

  const chosen = chooseDailyQuests(quests, NUM_DAILY_QUESTS, COOLDOWN_DAYS);

  for (const quest of chosen) {
    await createDailyQuestRow(quest);
  }
  console.log(`✅ Created ${chosen.length} daily quests.`);
}

function parseQuest(row) {
  const props = row.properties || {};
  const titleProp = props["Quest Name"] || props["Name"];
  let name = "Untitled";
  if (titleProp?.title?.[0]?.text?.content) {
    name = titleProp.title[0].text.content;
  }
  const timesCompleted = props["Times Completed"]?.number || 0;
  const lastCompletedIso = props["Last Completed"]?.date?.start;
  const lastCompleted = lastCompletedIso ? new Date(lastCompletedIso) : null;
  return { id: row.id, name, timesCompleted, lastCompleted };
}

function chooseDailyQuests(quests, count, cooldownDays) {
  const today = new Date();
  const eligible = quests.filter(q => {
    if (!q.lastCompleted) return true;
    const diffDays = (today - q.lastCompleted) / (1000 * 60 * 60 * 24);
    return diffDays >= cooldownDays;
  });

  let sorted = eligible.sort((a, b) => a.timesCompleted - b.timesCompleted);
  return sorted.slice(0, count);
}

async function createDailyQuestRow(quest) {
  const url = "https://api.notion.com/v1/pages";
  const payload = {
    parent: { type: "data_source_id", data_source_id: DAILY_TRACKER_DS },
    properties: {
      Name: { title: [{ text: { content: quest.name } }] },
      Completed: { checkbox: false },
      "Quest Master": { relation: [{ id: quest.id }] }
    }
  };
  try {
    await notionPost(url, payload);
    console.log(`✅ Created daily quest row: ${quest.name}`);
  } catch (err) {
    console.log(`❌ Failed to create quest row: ${err}`);
  }
}

/* =======================
   QUEST LOG
======================= */
async function questLog(env) {
  console.log("Checking completed quests...");
  const daily = await notionPost(
    `https://api.notion.com/v1/data_sources/${DAILY_TRACKER_DS}/query`,
    {}
  );
  const completed = daily.results.filter(r => r.properties?.Completed?.checkbox);

  if (!completed.length) {
    console.log("ℹ️ No completed quests.");
    return;
  }

  for (const q of completed) {
    const name = q.properties?.Name?.title?.[0]?.text?.content || "Unnamed Quest";
    const questMasterRel = q.properties?.["Quest Master"]?.relation || [];
    if (!questMasterRel.length) {
      console.log(`⚠️ Skipping ${name} — no Quest Master relation`);
      continue;
    }
    const questMasterId = questMasterRel[0].id;

    // Fetch Quest Master details
    const questMaster = await notionGet(`https://api.notion.com/v1/pages/${questMasterId}`);
    const xp = questMaster.properties?.["XP Value"]?.number || 0;
    const skill = questMaster.properties?.["Skill"]?.select?.name || "General";

    // Check if already logged today
    if (await questLoggedToday(questMasterId)) {
      console.log(`ℹ️ Quest ${name} already logged today, skipping XP.`);
      await logQuest(name, 0, skill, questMasterId);
    } else {
      await logQuest(name, xp, skill, questMasterId);
      await updateQuestMaster(questMasterId, questMaster.properties);
    }
  }
}

async function questLoggedToday(questMasterId) {
  const today = new Date().toISOString().split("T")[0];
  const payload = {
    filter: {
      and: [
        { property: "Quest Master", relation: { contains: questMasterId } },
        { property: "Completed On", date: { on_or_after: today } }
      ]
    }
  };
  const res = await notionPost(
    `https://api.notion.com/v1/data_sources/${QUEST_LOG_DS}/query`,
    payload
  );
  return res.results.length > 0;
}

async function logQuest(name, xp, skill, questMasterId) {
  const url = "https://api.notion.com/v1/pages";
  const payload = {
    parent: { type: "data_source_id", data_source_id: QUEST_LOG_DS },
    properties: {
      Name: { title: [{ text: { content: name } }] },
      "XP Earned": { number: xp },
      Skill: { rich_text: [{ text: { content: skill } }] },
      "Quest Master": { relation: [{ id: questMasterId }] },
      "Completed On": { date: { start: new Date().toISOString() } }
    }
  };
  await notionPost(url, payload);
  console.log(`✅ Logged quest ${name} (${xp} XP)`);
}

async function updateQuestMaster(id, props) {
  const timesCompleted = (props?.["Times Completed"]?.number || 0) + 1;
  await notionPatch(`https://api.notion.com/v1/pages/${id}`, {
    properties: {
      "Times Completed": { number: timesCompleted },
      "Last Completed": { date: { start: new Date().toISOString() } }
    }
  });
  console.log(`🔄 Updated Quest Master ${id} → Times Completed = ${timesCompleted}`);
}
