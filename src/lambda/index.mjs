// src/lambda/index.mjs
// AWS Cost Hygiene Guard - v2
// - Cost Explorer: actual UnblendedCost (last 7 days) by SERVICE and by COST_TAG_KEY
// - Per-resource view (utilization) for EC2 instances + DynamoDB tables
// - Sends combined summary to Slack using a bot token

import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";

import {
  EC2Client,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";

import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";

import {
  DynamoDBClient,
  ListTablesCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";

// ---------- Clients ----------

// Cost Explorer is only in us-east-1
const ceClient = new CostExplorerClient({ region: "us-east-1" });

// Region for resource/utilization scans comes from Lambda env (AWS_REGION)
const ec2 = new EC2Client({});
const cloudwatch = new CloudWatchClient({});
const dynamodb = new DynamoDBClient({});

// ---------- Env vars ----------

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const COST_TAG_KEY = process.env.COST_TAG_KEY || "Project"; // e.g. Project, Environment

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
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    Start: formatDate(start),
    End: formatDate(end),
  };
}

// ---------- Cost Explorer helpers (actual $) ----------

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

// ---------- CloudWatch helper for utilization ----------

async function getMetricAggregate({
  namespace,
  metricName,
  dimensions,
  startTime,
  endTime,
  periodSeconds,
  statistic = "Average", // or "Sum"
}) {
  const cmd = new GetMetricStatisticsCommand({
    Namespace: namespace,
    MetricName: metricName,
    Dimensions: dimensions,
    StartTime: startTime,
    EndTime: endTime,
    Period: periodSeconds,
    Statistics: [statistic],
  });

  const resp = await cloudwatch.send(cmd);
  const datapoints = resp.Datapoints ?? [];
  if (datapoints.length === 0) return null;

  const key = statistic;
  const sum = datapoints.reduce((acc, dp) => acc + (dp[key] ?? 0), 0);
  return sum / datapoints.length;
}

// ---------- EC2 per-instance utilization ----------

const EC2_LOOKBACK_DAYS = 7;
const EC2_IDLE_CPU_THRESHOLD = 5; // %

async function buildEc2Section() {
  const endTime = new Date();
  const startTime = new Date(
    endTime.getTime() - EC2_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  );

  const describeResp = await ec2.send(new DescribeInstancesCommand({}));

  const runningInstances = [];

  for (const reservation of describeResp.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      if (instance.State?.Name !== "running") continue;
      runningInstances.push({
        instanceId: instance.InstanceId,
        instanceType: instance.InstanceType,
        az: instance.Placement?.AvailabilityZone,
        launchTime: instance.LaunchTime,
        tags: instance.Tags ?? [],
      });
    }
  }

  console.log(`EC2: found ${runningInstances.length} running instance(s).`);

  const detailed = [];
  for (const inst of runningInstances) {
    const avgCpu = await getMetricAggregate({
      namespace: "AWS/EC2",
      metricName: "CPUUtilization",
      dimensions: [{ Name: "InstanceId", Value: inst.instanceId }],
      startTime,
      endTime,
      periodSeconds: 3600,
      statistic: "Average",
    });

    detailed.push({ ...inst, avgCpu });
  }

  const idleInstances = detailed.filter(
    (inst) =>
      typeof inst.avgCpu === "number" &&
      inst.avgCpu < EC2_IDLE_CPU_THRESHOLD
  );

  let text = "=== EC2 (Instances & CPU Utilization) ===\n";
  text += `Lookback: last ${EC2_LOOKBACK_DAYS} day(s)\n`;
  text += `Idle threshold: ${EC2_IDLE_CPU_THRESHOLD}% avg CPU\n`;
  text += `Running instances: ${runningInstances.length}\n`;
  text += `Idle candidates: ${idleInstances.length}\n\n`;

  if (runningInstances.length === 0) {
    text += "No running instances in this region.\n";
    return text;
  }

  text += "Per-instance details:\n";
  for (const inst of detailed) {
    const nameTag =
      inst.tags.find((t) => t.Key === "Name")?.Value ?? "<no-name>";
    const cpuStr =
      typeof inst.avgCpu === "number"
        ? inst.avgCpu.toFixed(2) + "%"
        : "n/a";
    const idleFlag =
      typeof inst.avgCpu === "number" &&
      inst.avgCpu < EC2_IDLE_CPU_THRESHOLD
        ? "IDLE?"
        : "";

    text += `- ${inst.instanceId} (${nameTag}) | ${inst.instanceType} | ${inst.az} | avg CPU: ${cpuStr} ${idleFlag}\n`;
  }

  text += "\n";
  return text;
}

// ---------- DynamoDB per-table utilization ----------

const DDB_LOOKBACK_DAYS = 7;
// Approximate on-demand pricing (adjust for your region if you want)
const DDB_READ_PRICE_PER_MILLION = 0.25;   // $ per 1M read request units
const DDB_WRITE_PRICE_PER_MILLION = 1.25;  // $ per 1M write request units
const DDB_STORAGE_PRICE_PER_GB_MONTH = 0.25; // $ per GB-month

// ---------- DynamoDB per-table utilization + estimated cost ----------

async function buildDynamoSection() {
  const endTime = new Date();
  const startTime = new Date(
    endTime.getTime() - DDB_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  );

  // Sum capacity units over lookback window
  async function getDynamoCapacitySum(tableName, metricName) {
    const cmd = new GetMetricStatisticsCommand({
      Namespace: "AWS/DynamoDB",
      MetricName: metricName, // ConsumedReadCapacityUnits / ConsumedWriteCapacityUnits
      Dimensions: [{ Name: "TableName", Value: tableName }],
      StartTime: startTime,
      EndTime: endTime,
      Period: 3600, // 1 hour
      Statistics: ["Sum"],
    });

    const resp = await cloudwatch.send(cmd);
    const dps = resp.Datapoints ?? [];
    if (dps.length === 0) return 0;

    return dps.reduce((acc, dp) => acc + (dp.Sum ?? 0), 0);
  }

  const allTableNames = [];
  let lastEvaluatedTableName = undefined;

  do {
    const listResp = await dynamodb.send(
      new ListTablesCommand({
        ExclusiveStartTableName: lastEvaluatedTableName,
      })
    );
    const names = listResp.TableNames ?? [];
    allTableNames.push(...names);
    lastEvaluatedTableName = listResp.LastEvaluatedTableName;
  } while (lastEvaluatedTableName);

  console.log(`DynamoDB: found ${allTableNames.length} table(s).`);

  let text = "=== DynamoDB (Tables, Capacity & Est. Cost) ===\n";
  text += `Lookback: last ${DDB_LOOKBACK_DAYS} day(s)\n`;
  text += `Pricing (approx, on-demand): reads $${DDB_READ_PRICE_PER_MILLION}/M, writes $${DDB_WRITE_PRICE_PER_MILLION}/M, storage $${DDB_STORAGE_PRICE_PER_GB_MONTH}/GB-month\n`;
  text += `Total tables: ${allTableNames.length}\n\n`;

  if (allTableNames.length === 0) {
    text += "No DynamoDB tables in this region.\n";
    return { text, estimatedMonthlyCost: 0 };
  }

  let totalDdbMonthlyCost = 0;

  for (const tableName of allTableNames) {
    try {
      const descResp = await dynamodb.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const t = descResp.Table;
      if (!t) continue;

      const sizeBytes = t.TableSizeBytes ?? 0;
      const sizeGB = sizeBytes / (1024 * 1024 * 1024);
      const itemCount = t.ItemCount ?? 0;
      const billingMode =
        t.BillingModeSummary?.BillingMode ?? "PROVISIONED";

      // Usage in the lookback window
      const totalReadUnits = await getDynamoCapacitySum(
        tableName,
        "ConsumedReadCapacityUnits"
      );
      const totalWriteUnits = await getDynamoCapacitySum(
        tableName,
        "ConsumedWriteCapacityUnits"
      );

      // Scale from N-day window up to a 30-day month estimate
      const scaleToMonth = 30 / DDB_LOOKBACK_DAYS;
      const estMonthlyReadUnits = totalReadUnits * scaleToMonth;
      const estMonthlyWriteUnits = totalWriteUnits * scaleToMonth;

      const readsCost =
        (estMonthlyReadUnits / 1_000_000) * DDB_READ_PRICE_PER_MILLION;
      const writesCost =
        (estMonthlyWriteUnits / 1_000_000) * DDB_WRITE_PRICE_PER_MILLION;
      const storageCost = sizeGB * DDB_STORAGE_PRICE_PER_GB_MONTH;

      const tableCost = readsCost + writesCost + storageCost;
      totalDdbMonthlyCost += tableCost;

      text += `- ${tableName} | items: ${itemCount} | size: ${sizeGB.toFixed(
        3
      )} GB | mode: ${billingMode}`;
      text += ` | read units: ${totalReadUnits.toFixed(
        0
      )}, write units: ${totalWriteUnits.toFixed(0)}`;
      text += ` | est monthly cost: $${tableCost.toFixed(2)} (reads $${readsCost.toFixed(
        2
      )}, writes $${writesCost.toFixed(2)}, storage $${storageCost.toFixed(
        2
      )})\n`;
    } catch (err) {
      console.error(`Failed to describe/measure table ${tableName}:`, err);
      text += `- ${tableName} | <error describing or reading metrics>\n`;
    }
  }

  text += `\nEstimated DynamoDB monthly total (all tables): $${totalDdbMonthlyCost.toFixed(
    2
  )}\n`;
  text +=
    "(Estimate based on consumed capacity + size; actual bill may differ, especially for PROVISIONED tables.)\n\n";

  return { text, estimatedMonthlyCost: totalDdbMonthlyCost };
}

// ---------- Slack helper ----------

async function postToSlack(text) {
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
    console.log("Slack env vars not set; skipping Slack notification.");
    return;
  }

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL_ID,
      text,
    }),
  });

  const data = await res.json();
  if (!data.ok) {
    console.error("Slack API error:", data);
  } else {
    console.log("Posted cost summary to Slack, ts:", data.ts);
  }
}

// ---------- Lambda handler ----------

export const handler = async (event, context) => {
  try {
    // 1) Billing view – actual $ by SERVICE
    const { timePeriod, arr } = await getCostByServiceLast7Days();
    const topServices = arr.slice(0, 10);

    // 2) Resource view – utilization details (EC2 + DynamoDB)
    let resourceDetails = "";
    let ddbEstimatedMonthlyCost = null;

    try {
      const ec2Text = await buildEc2Section();
      resourceDetails += ec2Text;
    } catch (e) {
      console.error("EC2 section failed:", e);
      resourceDetails += "=== EC2 ===\nError collecting EC2 utilization.\n\n";
    }

    try {
      const { text: ddbText, estimatedMonthlyCost } = await buildDynamoSection();
      resourceDetails += ddbText;
      ddbEstimatedMonthlyCost = estimatedMonthlyCost;
    } catch (e) {
      console.error("Dynamo section failed:", e);
      resourceDetails +=
        "=== DynamoDB ===\nError collecting DynamoDB utilization.\n\n";
    }

    // 3) Build Slack text now that we have everything

    let slackText =
      `*AWS Cost – Top ${topServices.length} services (last 7 days)*\n` +
      `Range (UTC): \`${timePeriod.Start}\` → \`${timePeriod.End}\` (end exclusive)\n`;

    for (const entry of topServices) {
      slackText += `• *${entry.service}*: $${entry.amount.toFixed(4)}\n`;
    }

    // Billing view – by tag (e.g. Project)
    if (COST_TAG_KEY) {
      try {
        const { arr: tagArr } = await getCostByTagLast7Days(COST_TAG_KEY);
        const topTags = tagArr.slice(0, 10);

        slackText += `\n*Top ${topTags.length} tag values – \`${COST_TAG_KEY}\` (last 7 days)*\n`;
        for (const entry of topTags) {
          slackText += `• *${entry.value}*: $${entry.amount.toFixed(4)}\n`;
        }
      } catch (tagErr) {
        console.error("Error getting tag breakdown:", tagErr);
        slackText += `\n_(Tag breakdown failed for \`${COST_TAG_KEY}\` – see Lambda logs.)_\n`;
      }
    }

    // Optional high-level Dynamo estimate from per-table analysis
    if (ddbEstimatedMonthlyCost !== null) {
      slackText += `\n*Estimated DynamoDB monthly total (per-table usage & size):* ~$${ddbEstimatedMonthlyCost.toFixed(
        2
      )}\n`;
    }

    // Append detailed resource view as a code block
    if (resourceDetails) {
      slackText += `\n\`\`\`\n${resourceDetails}\n\`\`\``;
    }

    await postToSlack(slackText);

    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          message: "Cost & utilization scan complete",
          range: timePeriod,
          topServices,
          tagKey: COST_TAG_KEY,
        },
        null,
        2
      ),
    };
  } catch (err) {
    console.error("Error in cost scanner:", err);
    throw err;
  }
};
