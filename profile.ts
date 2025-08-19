#!/usr/bin/env bun

import { spawn } from "bun";
import { $ } from "bun";

const SERVER_PORT = 3001;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const WARMUP_TIME = 3000;
const BENCHMARK_DURATION = "30s";
const CONCURRENCY = 500;

const BUN_DEBUG = `${process.env.HOME}/ghq/github.com/oven-sh/bun/build/debug/bun-debug`;
const HONO_SERVER = "./hono-server.js";

async function waitForServer(url: string, maxAttempts = 30): Promise<boolean> {
  console.log(`   Checking ${url}...`);
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(url);
      console.log(`   ✓ Server responded with status ${response.status}`);
      return true;
    } catch (e) {
      if (i % 5 === 0) {
        console.log(`   Still waiting... (attempt ${i + 1}/${maxAttempts})`);
      }
    }
    await Bun.sleep(1000);
  }
  return false;
}

async function runBenchmark() {
  console.log("🚀 Starting Hono benchmark with profiling...");
  console.log(`📍 Using debug build: ${BUN_DEBUG}`);
  console.log(`📍 Server script: ${HONO_SERVER}`);
  
  console.log("🔧 Spawning server with samply profiling...");
  const serverProcess = spawn({
    cmd: [
      "samply",
      "record",
      "--save-only",
      "-o", "hono-profile.json",
      BUN_DEBUG,
      HONO_SERVER
    ],
    env: {
      ...process.env,
      BUN_JSC_useJITDump: "1",
      BUN_JSC_useTextMarkers: "1",
      BUN_JSC_exposeProfilersOnGlobalObject: "1",
      PORT: SERVER_PORT.toString()
    },
    stdout: "pipe",
    stderr: "pipe"
  });

  (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of serverProcess.stdout) {
      const text = decoder.decode(chunk);
      console.log(`[SERVER] ${text.trim()}`);
    }
  })();

  (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of serverProcess.stderr) {
      const text = decoder.decode(chunk);
      console.error(`[SERVER ERROR] ${text.trim()}`);
    }
  })();

  console.log("⏳ Waiting for server to start...");
  const serverReady = await waitForServer(SERVER_URL);
  
  if (!serverReady) {
    console.error("❌ Server failed to start after 30 seconds");
    serverProcess.kill("SIGTERM");
    process.exit(1);
  }
  
  console.log("✅ Server is running");
  
  console.log("🔥 Warming up the server...");
  try {
    await $`bombardier -c 10 -d 5s -q ${SERVER_URL}/user`.quiet();
    await Bun.sleep(1000);
  } catch (e) {
    console.log("⚠️  Warmup completed (bombardier may have shown warnings)");
  }
  
  const endpoints = [
    { path: "/user", name: "User endpoint" },
    { path: "/user/comments", name: "User comments" },
    { path: "/event/123", name: "Event by ID" },
    { path: "/event/123/comments", name: "Event comments" },
    { path: "/user/lookup/username/testuser", name: "User lookup" },
    { path: "/very/deeply/nested/route/hello/there", name: "Deeply nested route" }
  ];
  
  console.log("\n📊 Running benchmarks...");
  console.log(`   Duration: ${BENCHMARK_DURATION} per endpoint`);
  console.log(`   Concurrency: ${CONCURRENCY} connections\n`);
  
  for (const endpoint of endpoints) {
    console.log(`\n🎯 Testing: ${endpoint.name}`);
    console.log(`   URL: ${SERVER_URL}${endpoint.path}`);
    console.log("   " + "=".repeat(50));
    
    try {
      const result = await $`bombardier \
        -c ${CONCURRENCY} \
        -d ${BENCHMARK_DURATION} \
        --print result \
        ${SERVER_URL}${endpoint.path}`.text();
      const lines = result.split('\n');
      const statsLines = lines.filter(line => 
        line.includes('Reqs/sec') || 
        line.includes('Latency') || 
        line.includes('Throughput')
      );
      if (statsLines.length > 0) {
        console.log("   Results:");
        statsLines.forEach(line => console.log(`   ${line.trim()}`));
      }
    } catch (e) {
      console.error(`   ❌ Benchmark failed for ${endpoint.path}:`, e);
    }
  }
  
  console.log("\n🛑 Benchmarks complete, stopping server...");
  
  serverProcess.kill("SIGTERM");
  
  await Bun.sleep(500);
  
  try {
    serverProcess.kill("SIGKILL");
    console.log("⚠️  Forced termination with SIGKILL");
  } catch (e) {
  }
  
  await serverProcess.exited;
  
  try {
    await $`lsof -ti:${SERVER_PORT} | xargs kill -9 2>/dev/null || true`.quiet();
    console.log("🧹 Cleaned up any remaining processes on port", SERVER_PORT);
  } catch (e) {
  }
  
  console.log("\n✨ Benchmark complete!");
  console.log("📈 Profile saved to: hono-profile.json");
  console.log("📊 View profile with: samply load hono-profile.json");
}

if (import.meta.main) {
  try {
    await runBenchmark();
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Benchmark failed with error:", error);
    process.exit(1);
  }
}
