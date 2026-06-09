import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { getExtensionConfiguration } from '../configuration/getExtensionConfiguration';
import TestCase from '../testTree/TestCase';

export class CucumberRunner {
    private static cucumberProcess: ChildProcessWithoutNullStreams | undefined;

    public static async runTest(testRun: vscode.TestRun, testCase: TestCase, debug?: boolean): Promise<string[]> {
        this.killCucumberProcess();

        return new Promise((resolve) => {
            const cucumberOutput: string[] = [];

            this.cucumberProcess = this.spawnCucumberProcess(testRun, testCase, debug);

            this.cucumberProcess.stdout.on('data', (chunk: any) => {
                this.log(testRun, chunk);
                cucumberOutput.push(chunk.toString());
            });

            this.cucumberProcess.stderr.on('data', (chunk: any) => {
                this.log(testRun, chunk);
            });

            this.cucumberProcess.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
                resolve(cucumberOutput);
            });
        });
    }

    private static spawnCucumberProcess(testRun: vscode.TestRun, testCase: TestCase, debug?: boolean): ChildProcessWithoutNullStreams {
        const { featurePaths, env, cliOptions, cucumberPath, cwd, debugEnv } = getExtensionConfiguration();

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

        this.log(testRun,
            'Executing command: '
            + (debug && Object.keys(debugEnv).length ? `${Object.keys(debugEnv).map(vr => vr + '=......').join(' ')} ` : '')
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
                    ...(debug && debugEnv),
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
