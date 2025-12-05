// index.mjs - Node.js 24, ES modules, AWS SDK v3
// v1: EC2 inventory + idle detector (logs a text report)
//
// - Lists all *running* EC2 instances
// - Pulls average CPU over the last 7 days from CloudWatch
// - Flags "idle" instances below a CPU threshold
// - Logs a human-readable report to CloudWatch Logs

import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";

const ec2 = new EC2Client({});
const cloudwatch = new CloudWatchClient({});

// Threshold: avg CPU below this is considered "idle"
const IDLE_CPU_THRESHOLD = 5; // percent
const LOOKBACK_DAYS = 7;

// Helper: get average CPU utilization for one instance over last N days
async function getAverageCpuForInstance(instanceId) {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const params = {
    Namespace: "AWS/EC2",
    MetricName: "CPUUtilization",
    Dimensions: [{ Name: "InstanceId", Value: instanceId }],
    StartTime: startTime,
    EndTime: endTime,
    Period: 3600, // 1 hour datapoints
    Statistics: ["Average"],
  };

  const resp = await cloudwatch.send(new GetMetricStatisticsCommand(params));
  const datapoints = resp.Datapoints ?? [];

  if (datapoints.length === 0) {
    // No metric data (brand new instance or stopped most of the time)
    return null;
  }

  const sum = datapoints.reduce(
    (acc, dp) => acc + (dp.Average ?? 0),
    0
  );
  return sum / datapoints.length;
}

export const handler = async (event) => {
  console.log("Cost Hygiene Guard scan started at", new Date().toISOString());
  console.log("Event payload:", JSON.stringify(event, null, 2));

  try {
    // 1) Get all running EC2 instances
    const describeResp = await ec2.send(
      new DescribeInstancesCommand({})
    );

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

    console.log(`Found ${runningInstances.length} running EC2 instance(s).`);

    // 2) For each running instance, fetch avg CPU
    const withCpu = [];
    for (const inst of runningInstances) {
      const avgCpu = await getAverageCpuForInstance(inst.instanceId);
      withCpu.push({ ...inst, avgCpu });
    }

    // 3) Determine idle instances
    const idleInstances = withCpu.filter(
      (inst) =>
        typeof inst.avgCpu === "number" &&
        inst.avgCpu < IDLE_CPU_THRESHOLD
    );

    // 4) Build human-readable report
    let report = "";
    report += `AWS Cost Hygiene Report - ${new Date().toISOString()}\n\n`;
    report += `Lookback window: last ${LOOKBACK_DAYS} day(s)\n`;
    report += `Idle threshold: ${IDLE_CPU_THRESHOLD}% average CPU\n\n`;
    report += `Total running EC2 instances: ${runningInstances.length}\n`;
    report += `Idle instances detected: ${idleInstances.length}\n\n`;

    if (idleInstances.length === 0) {
      report += "No idle instances detected based on CPU utilization.\n";
    } else {
      report += "Idle instance candidates:\n";
      for (const inst of idleInstances) {
        // try to find a Name tag if present
        const nameTag =
          inst.tags.find((t) => t.Key === "Name")?.Value ?? "<no-name>";

        report += `- ${inst.instanceId} (${nameTag}) | ${inst.instanceType} | ${inst.az} | avg CPU: ${inst.avgCpu.toFixed(
          2
        )}%\n`;
      }
    }

    console.log("------ BEGIN REPORT ------");
    console.log(report);
    console.log("------- END REPORT -------");

    // 5) Return a short JSON summary (useful when testing manually)
    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          message: "EC2 idle scan complete",
          totalRunning: runningInstances.length,
          idleCount: idleInstances.length,
        },
        null,
        2
      ),
    };
  } catch (err) {
    console.error("Error during idle scan:", err);
    throw err;
  }
};
