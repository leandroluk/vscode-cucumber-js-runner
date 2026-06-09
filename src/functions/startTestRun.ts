import * as vscode from 'vscode';
import { CucumberRunner } from '../cucumber/CucumberRunner';
import TestCase from '../testTree/TestCase';
import TestFile from '../testTree/TestFile';
import { testItemDataMap } from '../other';

export const startTestRun = async (controller: vscode.TestController, request: vscode.TestRunRequest, token: vscode.CancellationToken, debug: boolean = false) => {
    const testRun = controller.createTestRun(request);

    token.onCancellationRequested(() => {
        CucumberRunner.killCucumberProcess();
        testRun.appendOutput('Run instance cancelled.\r\n\n');
    });

    const initialTests = request.include ?? gatherTestItems(controller.items);
    const testQueue = await discoverTests(initialTests);
    await runTestQueue(testQueue);

    async function discoverTests(testItems: Iterable<vscode.TestItem>): Promise<{ testItem: vscode.TestItem; testCase: TestCase; }[]> {
        const testQueue: { testItem: vscode.TestItem; testCase: TestCase }[] = [];
        for (const testItem of testItems) {
            if (request.exclude?.includes(testItem)) {
                continue;
            }

            const testItemData = testItemDataMap.get(testItem);
            if (testItemData instanceof TestCase) {
                testRun.enqueued(testItem);
                testQueue.push({ testItem: testItem, testCase: testItemData });
            } else {
                if (testItemData instanceof TestFile && !testItemData.didResolve) {
                    await testItemData.updateFromDisk(controller, testItem);
                }
                testQueue.push(...(await discoverTests(gatherTestItems(testItem.children))));
            }
        }
        return testQueue;
    }

    async function runTestQueue(testQueue: { testItem: vscode.TestItem; testCase: TestCase }[]): Promise<void> {
        for (const { testItem, testCase } of testQueue) {
            if (!token.isCancellationRequested) {
                testRun.started(testItem);
                const testResults = await runTest(testCase);
                processTestResults(testItem, testCase, testResults);
            } else {
                testRun.skipped(testItem);
            }
        }
        testRun.end();
    }

    async function runTest(testCase: TestCase): Promise<string[]> {
        testRun.appendOutput(`Running test: ${testCase.name}\r\n`);
        const cucumberOutput = await CucumberRunner.runTest(testRun, testCase, debug);
        if (!token.isCancellationRequested) {
            testRun.appendOutput('Finished running test!\r\n\n');
        }
        return cucumberOutput;
    }

    async function processTestResults(testItem: vscode.TestItem, testCase: TestCase, cucumberOutput: string[]): Promise<string> {
        let status: string = 'errored';
        let errorMessage: string | undefined;
        let executionTime: number | undefined;

        const fullOutput = cucumberOutput
            .join('\n')
            .replace(/\x1b\[[0-9;]*m/g, '')
            .replace(/[​-‍﻿]/g, '');

        // Check for failures block
        if (fullOutput.includes('Failures:')) {
            errorMessage = fullOutput.split('Failures:')[1].trim();
            status = 'failed';
        }

        // Parse timing line — supports both formats:
        //   old: "1m0.000s (executing steps: 0m0.000s)"
        //   new: "0m 0.88s (0m 0.71s executing your code)"
        const timingMatch = fullOutput.match(/(\d+)m\s*([\d.]+)s\s*\(/);
        if (timingMatch) {
            executionTime = Number(timingMatch[1]) * 60 + Number(timingMatch[2]);
        }

        // Parse scenario summary — supports both formats:
        //   old: "1 scenario (1 passed, 0 failed, 0 skipped)"
        //   new: "1 scenario (1 passed)"  /  "2 scenarios (1 passed, 1 failed)"
        const scenarioLine = fullOutput.match(/(\d+) scenarios?\s*\(([^)]+)\)/);
        if (scenarioLine && status !== 'failed') {
            const total = Number(scenarioLine[1]);
            const counts = scenarioLine[2];
            const passed = Number(counts.match(/(\d+) passed/)?.[1] ?? 0);
            const failed = Number(counts.match(/(\d+) failed/)?.[1] ?? 0);

            if (failed > 0) {
                status = 'failed';
                errorMessage = errorMessage ?? `${failed} of ${total} scenarios failed`;
            } else if (passed === total && total > 0) {
                status = 'passed';
            }
        } else if (/^0 scenarios$/m.test(fullOutput) && status === 'errored') {
            errorMessage = 'No matching scenario found — check line number or scenario name filter';
        }

        switch (status) {
            case 'passed':
                testRun.passed(testItem, executionTime);
                break;
            case 'errored':
                const errorMsg = new vscode.TestMessage(errorMessage ?? 'Unknown error! Please check logs for more information');
                errorMsg.location = new vscode.Location(testItem.uri!, testItem.range!.end);
                testRun.errored(testItem, errorMsg);
                break;
            case 'skipped':
                testRun.skipped(testItem);
                break;
            case 'failed':
                const failMsg = new vscode.TestMessage(errorMessage ?? 'Test failed');
                failMsg.location = new vscode.Location(testItem.uri!, testItem.range!.end);
                testRun.failed(testItem, failMsg, executionTime);
                break;
        }

        return status;
    }

    function gatherTestItems(testItemCollection: vscode.TestItemCollection): vscode.TestItem[] {
        const testItems: vscode.TestItem[] = [];
        testItemCollection.forEach(item => testItems.push(item));
        return testItems;
    }
};
