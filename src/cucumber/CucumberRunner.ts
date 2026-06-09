import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { getExtensionConfiguration } from '../configuration/getExtensionConfiguration';
import TestCase from '../testTree/TestCase';

export class CucumberRunner {
    private static cucumberProcess: ChildProcessWithoutNullStreams | undefined;
    private static debugTimeoutFile: string | undefined;

    public static runTest(testRun: vscode.TestRun, testCase: TestCase, debug?: boolean): Promise<string[]> {
        this.killCucumberProcess();

        const cucumberOutput: string[] = [];
        this.cucumberProcess = this.spawnCucumberProcess(testRun, testCase, debug);

        if (debug) {
            const { debugEnv } = getExtensionConfiguration();
            const port = this.extractDebugPort(debugEnv);
            // --inspect-brk pauses immediately — attach after brief delay for port to open
            setTimeout(() => {
                vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], {
                    type: 'node',
                    request: 'attach',
                    name: 'Attach to Cucumber',
                    port,
                    skipFiles: ['<node_internals>/**', '**/node_modules/**'],
                    sourceMaps: true,
                    continueOnAttach: true,
                }).then(undefined, (err: unknown) => {
                    this.log(testRun, `Warning: could not attach debugger: ${err}\r\n`);
                });
            }, 500);
        }

        return new Promise((resolve) => {
            this.cucumberProcess!.stdout.on('data', (chunk: any) => {
                this.log(testRun, chunk);
                cucumberOutput.push(chunk.toString());
            });

            this.cucumberProcess!.stderr.on('data', (chunk: any) => {
                this.log(testRun, chunk);
            });

            this.cucumberProcess!.on('close', () => {
                if (this.debugTimeoutFile) {
                    try { fs.unlinkSync(this.debugTimeoutFile); } catch {}
                    this.debugTimeoutFile = undefined;
                }
                resolve(cucumberOutput);
            });
        });
    }

    private static extractDebugPort(debugEnv: {[key: string]: string}): number {
        const nodeOptions = Object.values(debugEnv).find(v => v.includes('--inspect')) ?? '';
        const match = nodeOptions.match(/--inspect(?:-brk)?(?:=[^:]*:)?(\d+)/);
        return match?.[1] ? parseInt(match[1], 10) : 9229;
    }

    private static spawnCucumberProcess(testRun: vscode.TestRun, testCase: TestCase, debug?: boolean): ChildProcessWithoutNullStreams {
        const { featurePaths, env, cliOptions, cucumberPath, cwd, debugEnv, debugTimeout } = getExtensionConfiguration();

        let nodeArguments: string[];
        let logSuffix: string;

        if (testCase.featureFilePath && testCase.exampleLineNumber !== undefined) {
            // Use file:line targeting for Scenario Outline examples — more reliable than --name with appended params
            const fileTarget = `${testCase.featureFilePath}:${testCase.exampleLineNumber}`;
            nodeArguments = [cucumberPath, fileTarget, ...cliOptions];
            logSuffix = [cucumberPath, `"${fileTarget}"`, ...cliOptions].join(' ');
        } else {
            // Use --name regex for regular scenarios
            let scenarioNameRegexed = `^${testCase.name.replace(/([.+*?^$()[\]{}|\\])/g, '\\$1')}$`;
            scenarioNameRegexed = scenarioNameRegexed.replace(/<[^>]*>/g, ".*");
            nodeArguments = [cucumberPath, ...featurePaths, '--name', scenarioNameRegexed, ...cliOptions];
            logSuffix = [cucumberPath, ...featurePaths, '--name', `"${scenarioNameRegexed}"`, ...cliOptions].join(' ');
        }

        if (debug && debugTimeout !== null) {
            const cucumberPkg = path.join(cwd, 'node_modules', '@cucumber', 'cucumber');
            this.debugTimeoutFile = path.join(os.tmpdir(), `cucumber-debug-timeout-${Date.now()}.cjs`);
            fs.writeFileSync(
                this.debugTimeoutFile,
                `const { setDefaultTimeout } = require(${JSON.stringify(cucumberPkg)});\nsetDefaultTimeout(${debugTimeout});\n`
            );
            nodeArguments.push('--require', this.debugTimeoutFile);
        }

        const debugEnvMergedForLog = debug ? {NODE_OPTIONS: '--inspect-brk=9229', ...debugEnv} : {};
        this.log(testRun,
            'Executing command: '
            + (Object.keys(debugEnvMergedForLog).length ? `${Object.keys(debugEnvMergedForLog).map(vr => vr + '=......').join(' ')} ` : '')
            + (Object.keys(env).length ? `${Object.keys(env).map(vr => vr + '=......').join(' ')} ` : '')
            + 'node '
            + logSuffix
            + '\n\n'
        );

        return spawn(
            'node', nodeArguments,
            {
                cwd: cwd,
                env: {
                    ...process.env, ...env,
                    ...debugEnvMergedForLog,
                },
            }
        );
    }

    public static killCucumberProcess(signal?: NodeJS.Signals | number): boolean {
        if (this.cucumberProcess && !this.cucumberProcess.killed) {
            return this.cucumberProcess.kill(signal);
        }
        return true;
    }

    public static log(testRun: vscode.TestRun, message: any): void {
        testRun.appendOutput(message.toString().replaceAll('\n', '\r\n'));
    }
}
