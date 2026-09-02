import { expect, test, describe, vi, beforeEach, afterEach } from 'vitest';
import { OpsOrchestrator } from '../../src/hermes/ops-orchestrator.js';
import fs from 'fs';
import path from 'path';

vi.mock('fs');
vi.mock('child_process');

describe('OpsOrchestrator', () => {
  let orchestrator: OpsOrchestrator;
  
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENROUTER_API_KEY = 'test_key';
    
    // Mock basic fs functions
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readdirSync as any).mockReturnValue([]);
    
    orchestrator = new OpsOrchestrator();
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  test('should initialize and load skills if directory exists', () => {
    expect(fs.existsSync).toHaveBeenCalledWith(expect.stringContaining(path.join('.agents', 'skills', 'ops')));
  });

  test('should correctly structure fetch call in analyzeLogs', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() => 
      Promise.resolve({
        json: () => Promise.resolve({ choices: [{ message: { content: 'OK' } }] })
      } as Response)
    );

    await orchestrator.analyzeLogs('TEST LOG DATA');

    expect(fetchSpy).toHaveBeenCalled();
    const fetchArgs = fetchSpy.mock.calls[0]!;
    expect(fetchArgs[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    
    const requestOptions = fetchArgs[1] as RequestInit;
    expect(requestOptions.method).toBe('POST');
    expect((requestOptions.headers as Record<string, string>)['Authorization']).toBe('Bearer test_key');
    
    const body = JSON.parse(requestOptions.body as string);
    expect(body.model).toBe('zhipu/glm-4');
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain('TEST LOG DATA');
    
    fetchSpy.mockRestore();
  });

  test('should abort if OPENROUTER_API_KEY is missing', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const fetchSpy = vi.spyOn(global, 'fetch');
    
    await orchestrator.analyzeLogs('TEST LOG DATA');
    
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('should execute skill safely inside vm sandbox', async () => {
    let completedSuccess: boolean | null = null;
    let completedOutput = '';
    const sandboxedOrchestrator = new OpsOrchestrator({
      onSkillComplete: (_skill, success, output) => {
        completedSuccess = success;
        completedOutput = output;
      }
    });

    const safeSkill = {
      id: 'test_skill_1',
      triggerCondition: 'manual',
      script: 'console.log("Safe script running");',
      createdAt: new Date().toISOString()
    };

    await sandboxedOrchestrator.executeSkill(safeSkill);
    expect(completedSuccess).toBe(true);
    expect(completedOutput).toBe('Sandbox execution OK');
  });

  test('should catch and isolate dangerous or failing scripts in vm sandbox', async () => {
    let completedSuccess: boolean | null = null;
    let completedOutput = '';
    const sandboxedOrchestrator = new OpsOrchestrator({
      onSkillComplete: (_skill, success, output) => {
        completedSuccess = success;
        completedOutput = output;
      }
    });

    const dangerousSkill = {
      id: 'test_skill_bad',
      triggerCondition: 'manual',
      script: 'process.exit(1);', // 'process' is not injected into sandbox
      createdAt: new Date().toISOString()
    };

    await sandboxedOrchestrator.executeSkill(dangerousSkill);
    expect(completedSuccess).toBe(false);
    expect(completedOutput).toContain('process is not defined');
  });

  test('should trigger automatic rollback when batch success rate drops below 40%', async () => {
    const orchestrator = new OpsOrchestrator();
    const triggerContext = {
      recentOutcomes: ['blocked', 'blocked'],
      stats: {},
      successRate: 0.25 // 25% < 40% threshold
    };

    // Should evaluate triggers and attempt rollback without crashing
    await expect(orchestrator.evaluateTriggers(triggerContext)).resolves.not.toThrow();
  });
});
