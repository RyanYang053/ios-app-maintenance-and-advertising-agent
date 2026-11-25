import { tool } from '@opencode-ai/plugin';
import { execFile } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const commands = [
  'apps', 'scan', 'cycle', 'memory', 'feedback', 'inspect', 'history', 'store-draft',
  'brief', 'video', 'browser', 'record', 'observe', 'task', 'handoff',
  'dispatch-preview', 'dispatch', 'advance',
] as const;

function ownedFile(rootDir: string, path: string) {
  const base = realpathSync(rootDir);
  const candidate = realpathSync(resolve(base, path));
  const inside = relative(base, candidate);
  if (!inside || inside === '..' || inside.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) ||
    isAbsolute(inside)) throw new Error('Select a file inside the configured promotion workspace');
  return candidate;
}

export default tool({
  description: 'Run the iOS App Store and promotion workflow. Use this tool for all operator operations; app source is read through inspect.',
  args: {
    action: tool.schema.enum(commands),
    app: tool.schema.string().regex(/^\d+$/).optional(),
    task: tool.schema.number().int().positive().optional(),
    days: tool.schema.number().int().min(1).max(30).optional(),
    platform: tool.schema.enum(['asc', 'ads', 'tiktok', 'instagram', 'youtube', 'x', 'reddit', 'linkedin']).optional(),
    release: tool.schema.boolean().optional(),
    cached: tool.schema.boolean().optional(),
    inputJson: tool.schema.string().max(750000).optional().describe(
      'Inline JSON for task evidence, approved input or imported reports, as described in the operating guide.',
    ),
    inputAs: tool.schema.enum(['input', 'metrics', 'outcomes']).optional(),
    brief: tool.schema.string().max(4096).optional(),
    screenshot: tool.schema.string().max(4096).optional(),
  },
  async execute(args, context) {
    const params = [join(root, 'src', 'cli.mjs'), args.action];
    for (const key of ['app', 'task', 'days', 'platform'] as const) {
      if (args[key] !== undefined) params.push('--' + key, String(args[key]));
    }
    if (args.release) params.push('--release');
    if (args.cached) params.push('--cached');
    let input: string | undefined;
    if (args.inputJson !== undefined) {
      const parsed = JSON.parse(args.inputJson);
      const option = args.inputAs ?? 'input';
      const allowed = option === 'metrics' ? ['apps', 'scan', 'cycle'] : option === 'outcomes' ? ['cycle'] :
        ['store-draft', 'brief', 'record', 'observe', 'handoff', 'advance', 'dispatch'];
      if (!allowed.includes(args.action)) throw new Error('This command does not accept that input type');
      input = JSON.stringify(parsed);
      params.push('--' + option, '-');
      if (args.action === 'dispatch') {
        if (!/^[a-f0-9]{64}$/.test(parsed?.fingerprint ?? '')) throw new Error('Review the exact dispatch preview first');
        await context.ask({ permission: 'developer_issue_dispatch',
          patterns: [parsed.fingerprint], always: [],
          metadata: { task: args.task, fingerprint: parsed.fingerprint } });
      }
    }
    if (args.action === 'video') {
      if (!args.brief || !args.screenshot) throw new Error('Choose one generated brief and approved app screenshot');
      let config: { stateDir?: string } = {};
      try { config = JSON.parse(readFileSync(join(root, 'agent.config.json'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const stateDir = resolve(root, config.stateDir ?? '.agent-data');
      params.push('--brief', ownedFile(join(stateDir, 'drafts'), args.brief),
        '--screenshot', ownedFile(join(stateDir, 'assets'), args.screenshot));
    }
    return await new Promise<string>((done, fail) => {
      const child = execFile('node', params, {
        cwd: root, maxBuffer: 24 * 1024 * 1024, timeout: 600_000,
        signal: context.abort,
      }, (error, output, details) => {
        if (error) fail(new Error(details.trim() || 'Operator command failed'));
        else done(output);
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    });
  },
});
