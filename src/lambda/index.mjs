// index.mjs
// Cost Hygiene Guard - multi-service skeleton
// Node.js 24.x, ES modules, AWS SDK v3 clients from the runtime.
//
// v1: 
//  - EC2 section: still does idle detection via CPU and prints summary.
//  - DynamoDB section: lists tables and basic stats.
//  - Report aggregator: combines sections & sends to Slack.
//
// NOTE: estimatedMonthlyCost is 0 for now. Next step is to plug in real
// cost estimates per service (starting with DynamoDB).

import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  DynamoDBClient,
  ListTablesCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";

// --- Clients (region/credentials come from Lambda env) ---
const ec2 = new EC2Client({});
const cloudwatch = new CloudWatchClient({});
const dynamodb = new DynamoDBClient({});

// --- EC2 config ---
const EC2_LOOKBACK_DAYS = 7;
const EC2_IDLE_CPU_THRESHOLD = 5; // percent

// --- Helpers ---

/**
 * Generic CloudWatch metric helper:
 * Returns average (or sum) over datapoints for a metric.
 */
async function getMetricAggregate({
  namespace,
  metricName,
  dimensions,
  startTime,
  endTime,
  periodSeconds,
  statistic = "Average", // "Average" or "Sum"
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

  const key = statistic; // "Average" or "Sum"
  const sum = datapoints.reduce((acc, dp) => acc + (dp[key] ?? 0), 0);
  return sum / datapoints.length;
}

/**
 * Slack helper. Sends long text as a code block for readability.
 * Requires env var SLACK_WEBHOOK_URL.
 */
async function sendToSlack(reportText) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("No SLACK_WEBHOOK_URL set; skipping Slack notification.");
    return;
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "```" + reportText + "```",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("Failed to send Slack message:", res.status, body);
  } else {
    console.log("Slack notification sent.");
  }
}

// --- Section 1: EC2 (instances + idle detection) ---

async function buildEc2Section() {
  const endTime = new Date();
  const startTime = new Date(
    endTime.getTime() - EC2_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  );

  // 1) List all instances
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

  // 2) Fetch avg CPU for each running instance
  const detailed = [];
  for (const inst of runningInstances) {
    const avgCpu = await getMetricAggregate({
      namespace: "AWS/EC2",
      metricName: "CPUUtilization",
      dimensions: [{ Name: "InstanceId", Value: inst.instanceId }],
      startTime,
      endTime,
      periodSeconds: 3600, // 1h
      statistic: "Average",
    });

    detailed.push({ ...inst, avgCpu });
  }

  const idleInstances = detailed.filter(
    (inst) =>
      typeof inst.avgCpu === "number" &&
      inst.avgCpu < EC2_IDLE_CPU_THRESHOLD
  );

  // 3) Build section text
  let text = "=== EC2 (Instances) ===\n";
  text += `Lookback window: last ${EC2_LOOKBACK_DAYS} day(s)\n`;
  text += `Idle threshold: ${EC2_IDLE_CPU_THRESHOLD}% avg CPU\n`;
  text += `Running instances: ${runningInstances.length}\n`;
  text += `Idle candidates: ${idleInstances.length}\n\n`;

  if (runningInstances.length === 0) {
    text += "No running instances found in this region.\n";
  } else {
    if (idleInstances.length === 0) {
      text += "No instances appear idle based on CPU utilization.\n\n";
    } else {
      text += "Idle instance candidates:\n";
      for (const inst of idleInstances) {
        const nameTag =
          inst.tags.find((t) => t.Key === "Name")?.Value ?? "<no-name>";
        const cpuStr =
          typeof inst.avgCpu === "number"
            ? inst.avgCpu.toFixed(2) + "%"
            : "n/a";

        text += `- ${inst.instanceId} (${nameTag}) | ${inst.instanceType} | ${inst.az} | avg CPU: ${cpuStr}\n`;
      }
      text += "\n";
    }
  }

  // Cost estimation for EC2 will be added later.
  const estimatedMonthlyCost = 0;

  return { text, estimatedMonthlyCost };
}

// --- Section 2: DynamoDB (tables inventory for now) ---

async function buildDynamoSection() {
  // 1) List all tables (handle pagination)
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

  let text = "=== DynamoDB (Tables) ===\n";
  text += `Total tables: ${allTableNames.length}\n\n`;

  if (allTableNames.length === 0) {
    text += "No DynamoDB tables found in this region.\n";
    return { text, estimatedMonthlyCost: 0 };
  }

  // 2) Describe each table for basic stats
  for (const tableName of allTableNames) {
    try {
      const descResp = await dynamodb.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const t = descResp.Table;
      if (!t) continue;

      const sizeBytes = t.TableSizeBytes ?? 0;
      const sizeMB = sizeBytes / (1024 * 1024);
      const itemCount = t.ItemCount ?? 0;
      const billingMode =
        t.BillingModeSummary?.BillingMode ?? "PROVISIONED";

      const rcu = t.ProvisionedThroughput?.ReadCapacityUnits;
      const wcu = t.ProvisionedThroughput?.WriteCapacityUnits;

      text += `- ${tableName} | items: ${itemCount} | size: ${sizeMB.toFixed(
        2
      )} MB | mode: ${billingMode}`;

      if (billingMode === "PROVISIONED") {
        text += ` (RCU: ${rcu ?? "?"}, WCU: ${wcu ?? "?"})`;
      }

      text += "\n";
    } catch (err) {
      console.error(`Failed to describe table ${tableName}:`, err);
      text += `- ${tableName} | <error describing table>\n`;
    }
  }

  // Cost estimation for DynamoDB will be added in the next step.
  const estimatedMonthlyCost = 0;

  return { text, estimatedMonthlyCost };
}

// --- Main handler: call all sections, aggregate, report ---

export const handler = async (event) => {
  const startTs = new Date().toISOString();
  console.log("Cost Hygiene Guard run started at", startTs);
  console.log("Event payload:", JSON.stringify(event, null, 2));

  const sections = [];
  const serviceTotals = {};
  let grandTotal = 0;

  const recordSection = (serviceName, result) => {
    if (!result) return;
    sections.push(result.text);
    const est = result.estimatedMonthlyCost ?? 0;
    serviceTotals[serviceName] = est;
    grandTotal += est;
  };

  // EC2 section
  try {
    const ec2Section = await buildEc2Section();
    recordSection("EC2", ec2Section);
  } catch (err) {
    console.error("EC2 section failed:", err);
    sections.push("=== EC2 (Instances) ===\nError collecting EC2 data.\n");
  }

  // DynamoDB section
  try {
    const dynamoSection = await buildDynamoSection();
    recordSection("DynamoDB", dynamoSection);
  } catch (err) {
    console.error("DynamoDB section failed:", err);
    sections.push(
      "=== DynamoDB (Tables) ===\nError collecting DynamoDB data.\n"
    );
  }

  // In future we’ll add: Lambda, S3, SQS, SNS, API Gateway, EventBridge, ...

  // Build top-level summary
  let report = "";
  report += `AWS Cost Hygiene Guard - ${startTs}\n\n`;

  report += "Estimated monthly cost by service (USD, currently placeholders):\n";
  if (Object.keys(serviceTotals).length === 0) {
    report += "- No service totals available yet.\n\n";
  } else {
    for (const [svc, val] of Object.entries(serviceTotals)) {
      report += `- ${svc}: $${(val ?? 0).toFixed(2)}\n`;
    }
    report += `\nGrand total (estimated): $${grandTotal.toFixed(2)}\n\n`;
  }

  // Append all detailed sections
  report += sections.join("\n");

  console.log("------ BEGIN REPORT ------");
  console.log(report);
  console.log("------- END REPORT -------");

  try {
    await sendToSlack(report);
  } catch (err) {
    console.error("Slack notification failed:", err);
  }

  return {
    statusCode: 200,
    body: JSON.stringify(
      {
        message: "Cost Hygiene Guard run complete",
        services: serviceTotals,
      },
      null,
      2
    ),
  };
};
