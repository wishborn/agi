/**
 * `agi taskmaster` — Taskmaster job status and control.
 *
 * `agi taskmaster` prints a one-shot job listing (optionally scoped to one
 * project via `--project`, or `--json`). `agi taskmaster menu` launches the
 * interactive arrow-key TUI (Projects screen → Taskmaster screen) built on
 * the same raw-TTY primitives as `agi doctor menu`.
 */

import type { Command } from "commander";
import { GatewayClient, GatewayUnreachableError } from "../gateway-client.js";
import { bold, red } from "../output.js";

export function registerTaskmasterCommand(program: Command): void {
  const taskmaster = program
    .command("taskmaster")
    .description("Taskmaster job status and control")
    .option("--project <path>", "Scope to one project's jobs (absolute path)")
    .option("--json", "Output as JSON")
    .action(async (cmdOpts: { project?: string; json?: boolean }) => {
      const opts = program.opts<{ host?: string; port?: number }>();
      const client = new GatewayClient(opts.host ?? "127.0.0.1", opts.port ?? 3100);

      try {
        const jobs = await client.taskmasterJobs(cmdOpts.project);

        if (cmdOpts.json) {
          console.log(JSON.stringify(jobs, null, 2));
          return;
        }

        console.log();
        console.log(bold(`  Taskmaster jobs${cmdOpts.project ? ` — ${cmdOpts.project}` : ""}`));
        console.log();
        if (jobs.length === 0) {
          console.log("  No jobs.");
        } else {
          for (const job of jobs) {
            console.log(`  ${job.id}  [${job.status}]  ${job.description}`);
          }
        }
        console.log();
      } catch (err) {
        if (err instanceof GatewayUnreachableError) {
          console.error(red(err.message));
          process.exitCode = 1;
          return;
        }
        throw err;
      } finally {
        // A fetch() call anywhere in this process (pre-existing behavior —
        // also affects `agi doctor --with-aion`) leaves the event loop alive
        // after this one-shot command's work is genuinely done. Exit
        // explicitly rather than have every invocation hang until killed.
        process.exit(process.exitCode ?? 0);
      }
    });

  taskmaster
    .command("menu")
    .description("Interactive Taskmaster TUI — browse projects, view job status, approve/reject checkpoints")
    .action(async () => {
      const opts = program.opts<{ host?: string; port?: number }>();
      const { runTaskmasterMenu } = await import("./taskmaster-menu.js");
      await runTaskmasterMenu({ client: new GatewayClient(opts.host ?? "127.0.0.1", opts.port ?? 3100) });
      // See the one-shot action's comment above — a fetch() call anywhere
      // in this process leaves the event loop alive after the TUI quits.
      process.exit(0);
    });
}
