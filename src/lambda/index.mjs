// src/lambda/index.mjs
// AWS Cost Hygiene Guard - v1.1
// - Top services by UnblendedCost (last 7 days)
// - Optional: Top COST_TAG_KEY tag values by UnblendedCost (last 7 days)
// - Sends summary to Slack.

import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";

// Cost Explorer endpoint is in us-east-1
const ceClient = new CostExplorerClient({ region: "us-east-1" });

// Env vars (set in Lambda console)
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const COST_TAG_KEY = process.env.COST_TAG_KEY || "Project"; // e.g. "Project", "Environment"

// ---------- Date helpers ----------

function formatDate(d) {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Last 7 full days [Start, End) in UTC
function getLast7DaysRange() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    Start: formatDate(start),
    End: formatDate(end),
  };
}

// ---------- Cost Explorer helpers ----------

// 7-day UnblendedCost grouped by SERVICE
async function getCostByServiceLast7Days() {
  const timePeriod = getLast7DaysRange();
  console.log("Querying Cost Explorer (by SERVICE) for:", timePeriod);

  const command = new GetCostAndUsageCommand({
    TimePeriod: timePeriod,
    Granularity: "DAILY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
  });

  const resp = await ceClient.send(command);

  const totals = {}; // { SERVICE: number }

  for (const day of resp.ResultsByTime ?? []) {
    for (const group of day.Groups ?? []) {
      const serviceName = group.Keys[0] ?? "UNKNOWN";
      const amtStr = group.Metrics.UnblendedCost.Amount ?? "0";
      const amt = parseFloat(amtStr);
      if (!Number.isFinite(amt)) continue;
      totals[serviceName] = (totals[serviceName] || 0) + amt;
    }
  }

  const arr = Object.entries(totals)
    .map(([service, amount]) => ({ service, amount }))
    .sort((a, b) => b.amount - a.amount);

  return { timePeriod, arr };
}

// Parse tag key from CE response (they look like "Project$MyProject" or "Project$")
function parseTagValue(rawKey, tagKey) {
  if (!rawKey) return "(no value)";
  const prefix = `${tagKey}$`;
  if (rawKey.startsWith(prefix)) {
    const value = rawKey.slice(prefix.length);
    return value || "(no value)";
  }
  return rawKey;
}

// 7-day UnblendedCost grouped by TAG: COST_TAG_KEY
async function getCostByTagLast7Days(tagKey) {
  const timePeriod = getLast7DaysRange();
  console.log(`Querying Cost Explorer (by TAG: ${tagKey}) for:`, timePeriod);

  const command = new GetCostAndUsageCommand({
    TimePeriod: timePeriod,
    Granularity: "DAILY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "TAG", Key: tagKey }],
  });

  const resp = await ceClient.send(command);

  const totals = {}; // { tagValue: number }

  for (const day of resp.ResultsByTime ?? []) {
    for (const group of day.Groups ?? []) {
      const rawKey = group.Keys[0] ?? "";
      const value = parseTagValue(rawKey, tagKey);
      const amtStr = group.Metrics.UnblendedCost.Amount ?? "0";
      const amt = parseFloat(amtStr);
      if (!Number.isFinite(amt)) continue;
      totals[value] = (totals[value] || 0) + amt;
    }
  }

  const arr = Object.entries(totals)
    .map(([value, amount]) => ({ value, amount }))
    .sort((a, b) => b.amount - a.amount);

  return { timePeriod, arr };
}

// ---------- Slack helper ----------

async function postToSlack(text) {
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
    console.log("Slack env vars not set; skipping Slack notification.");
    return;
  }

  const payload = {
    channel: SLACK_CHANNEL_ID,
    text,
  };

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!data.ok) {
    console.error("Slack API error:", data);
  } else {
    console.log("Posted cost summary to Slack, ts:", data.ts);
  }
}

// ---------- Lambda handler ----------

// Handler path: src/lambda/index.handler
export const handler = async (event, context) => {
  try {
    // 1) Core: by SERVICE
    const { timePeriod, arr } = await getCostByServiceLast7Days();
    const topServices = arr.slice(0, 10);

    console.log("=== AWS COST HYGIENE GUARD - Top services (last 7 days) ===");
    console.log(`Range (UTC): ${timePeriod.Start} to ${timePeriod.End} (End exclusive)`);
    for (const entry of topServices) {
      console.log(`${entry.service.padEnd(40)} $${entry.amount.toFixed(4)}`);
    }

    let slackText =
      `*AWS Cost – Top ${topServices.length} services (last 7 days)*\n` +
      `Range (UTC): \`${timePeriod.Start}\` → \`${timePeriod.End}\` (end exclusive)\n`;

    for (const entry of topServices) {
      slackText += `• *${entry.service}*: $${entry.amount.toFixed(4)}\n`;
    }

    // 2) Bonus: by TAG (Project/Env/etc.), if COST_TAG_KEY is configured
    if (COST_TAG_KEY) {
      try {
        const { arr: tagArr } = await getCostByTagLast7Days(COST_TAG_KEY);
        const topTags = tagArr.slice(0, 10);

        console.log(
          `=== AWS COST HYGIENE GUARD - Top tag values for ${COST_TAG_KEY} (last 7 days) ===`
        );
        for (const entry of topTags) {
          console.log(`${entry.value.padEnd(40)} $${entry.amount.toFixed(4)}`);
        }

        slackText += `\n*Top ${topTags.length} tag values – \`${COST_TAG_KEY}\` (last 7 days)*\n`;
        for (const entry of topTags) {
          slackText += `• *${entry.value}*: $${entry.amount.toFixed(4)}\n`;
        }
      } catch (tagErr) {
        console.error("Error getting tag breakdown:", tagErr);
        slackText += `\n_(Tag breakdown failed for \`${COST_TAG_KEY}\` – see Lambda logs.)_`;
      }
    }

    await postToSlack(slackText);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Cost scan complete",
        range: timePeriod,
        topServices,
        tagKey: COST_TAG_KEY,
      }),
    };
  } catch (err) {
    console.error("Error in cost scanner:", err);
    throw err;
  }
};
