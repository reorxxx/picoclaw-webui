import { useState, useEffect, useRef, useMemo, memo } from 'react';
import { flushSync } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import {
    Settings, Bot, Send, Loader2, Power, Terminal, Save,
    Plus, MessageSquare, ChevronRight, ChevronDown, Cpu, Brain,
    Hash, Copy, Check, CheckCircle2, Square, Trash2, ListPlus, X,
    Zap,
    Repeat,
    CheckCircle,
    Clock // Added Clock
} from 'lucide-react';

import Modal from './components/Modal';

const API = 'http://localhost:3001';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
    role: string;
    content: string;
    tool_calls?: any[];
    tool_call_id?: string;
    reasoning_content?: string;
    logs?: string[];
    timestamp?: string;
    isHidden?: boolean;
}
interface Session {
    key: string; title: string; model: string;
    messageCount: number; updated: string | null; hasSummary: boolean;
}
interface Agent {
    key: string; workspace: string; model: string;
    temperature?: number; max_tokens?: number;
    sessionCount: number; hasIdentity: boolean;
    avatar: string; displayName: string;
}
type SidebarTab = 'agents' | 'settings';

/** Rough token estimator: ~3.5 chars per token for CJK+Latin mixed */
function estimateTokens(messages: Message[]): number {
    const chars = messages.reduce((acc, m) => acc + (m.content?.length || 0), 0);
    return Math.round(chars / 3.5);
}

// ─── Avatar component ─────────────────────────────────────────────────────────

function AvatarDisplay({ src, alt, size = 'md', className = "" }: { src: string; alt: string; size?: 'sm' | 'md' | 'lg', className?: string }) {
    const sz = size === 'sm' ? 'w-8 h-8 text-sm' : size === 'md' ? 'w-24 h-24 text-5xl' : 'w-32 h-32 text-6xl';
    // If it's a relative path (starts with /api), prepend with API base URL
    const finalSrc = (src.startsWith('/api') || src.startsWith('/avatars')) ? `${API}${src}` : src;
    const isImg = finalSrc.startsWith('/') || finalSrc.startsWith('http');

    // Determine background: gradient for emojis, transparent/glass for images
    const bgStyle = isImg
        ? 'bg-white/5 border border-white/10 backdrop-blur-sm'
        : (alt === 'user' ? 'bg-[#1E293B] border border-white/10' : 'bg-gradient-to-br from-blue-500 to-violet-600 border-transparent');

    return (
        <div className={`${sz} ${bgStyle} rounded-2xl flex items-center justify-center overflow-hidden flex-shrink-0 shadow-xl ${className}`}>
            {isImg ? <img src={finalSrc} alt={alt} className="w-full h-full object-cover" /> : <span>{finalSrc}</span>}
        </div>
    );
}

// ─── Log Cleaning Helpers ─────────────────────────────────────────────────────

function cleanLogLine(line: string): string {
    if (!line) return "";
    let cleaned = line.trim();
    // Greedily remove common log headers (timestamps, levels, agent tags)
    // Repeat to handle nested logging (e.g. gateway log containing agent log)
    const patterns = [
        /^\d{4}\/\d{2}\/\d{2}\s\d{2}:\d{2}:\d{2}\s/g,
        /^\[\d{4}-\d{2}-\d{2}T[\d:Z.\-]{8,}\]\s/g,
        /^\[(INFO|DEBUG|ERROR|WARN|INFO\d*)\]\s/gi,
        /agent\[[^\]]+\]:\s*/gi,
        /^\[picoclaw\s+\w+\]\s*/gi
    ];

    let previous;
    do {
        previous = cleaned;
        patterns.forEach(p => cleaned = cleaned.replace(p, ""));
        cleaned = cleaned.trim();
    } while (cleaned !== previous);

    return cleaned;
}

// ─── Tool Call Parsing ────────────────────────────────────────────────────────

function extractToolActions(logs: string[] | undefined): { action: string; subStatus: string; time: string | null; id: string }[] {
    if (!logs || logs.length === 0) {
        return [{ action: "正在处理中...", subStatus: "后台扫尾中，请等待...", time: null, id: 'fallback' }];
    }

    const actions: { action: string; subStatus: string; time: string | null; id: string }[] = [];
    let currentAction: any = null;

    for (const rawLine of logs) {
        const cleaned = cleanLogLine(rawLine);
        const lower = cleaned.toLowerCase();
        if (cleaned.length < 5) continue;

        let actionPrefix = "";
        let actionName = "";
        let matched = false;

        const timeMatch = rawLine.match(/(\d{1,2}:\d{2}:\d{2})/);
        const time = timeMatch ? timeMatch[1] : null;

        const subStatus = cleaned.length > 60 ? cleaned.slice(0, 60) + '...' : cleaned;

        // 1. Tool Calls
        if (lower.includes('calling tool') || lower.includes('executing tool')) {
            const m = cleaned.match(/tool\s+['"]?([^'"\s:]{2,})['"]?/i);
            actionName = m ? `使用工具: ${m[1]}` : "执行工具...";
            actionPrefix = "🛠️";
            matched = true;
        } else if (lower.includes('searching') || lower.includes('duckduckgo') || lower.includes('web search')) {
            actionName = "联网搜索...";
            actionPrefix = "🌐";
            matched = true;
        } else if (lower.includes('read file') || lower.includes('reading file')) {
            const m = cleaned.match(/(?:read|reading)\s+file\s+['"]?([^'"\s>]+)['"]?/i);
            const fileName = m ? (m[1].split('/').pop() || m[1]) : "";
            actionName = fileName ? `阅读文件: ${fileName}` : "读取文件...";
            actionPrefix = "📄";
            matched = true;
        } else if (lower.includes('write file') || lower.includes('writing to file')) {
            const m = cleaned.match(/(?:write|writing(?:\s+to)?)\s+file\s+['"]?([^'"\s>]+)['"]?/i);
            const fileName = m ? (m[1].split('/').pop() || m[1]) : "";
            actionName = fileName ? `写入文件: ${fileName}` : "保存文件...";
            actionPrefix = "📝";
            matched = true;
        } else if (lower.includes('loading memory') || lower.includes('agent context')) {
            actionName = "读取记忆库...";
            actionPrefix = "🧠";
            matched = true;
        } else if (lower.includes('reasoning') || lower.includes('thinking')) {
            actionName = "规划执行步骤...";
            actionPrefix = "💭";
            matched = true;
        }

        if (matched) {
            const fullAction = `${actionPrefix}正在${actionName}`;
            if (!currentAction || currentAction.action !== fullAction) {
                currentAction = { action: fullAction, subStatus, time, id: `${actions.length}-${time || Date.now()}` };
                actions.push(currentAction);
            } else {
                currentAction.subStatus = subStatus;
                if (!currentAction.time) currentAction.time = time;
            }
        } else if (currentAction && !lower.includes('[done]')) {
            // Update subStatus to show progress within current step
            currentAction.subStatus = subStatus;
        }
    }

    if (actions.length === 0) {
        return [{ action: "正在处理中...", subStatus: "后台执行中，请等待...", time: null, id: 'fallback' }];
    }

    return actions;
}

function ToolActionDisplay({ logs }: { logs: string[] }) {
    const actions = extractToolActions(logs);
    if (!actions || actions.length === 0) return null;

    return (
        <div className="flex flex-col gap-2.5 mb-3 bg-[#111827]/80 border border-white/5 p-3.5 rounded-xl w-fit shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-500 max-w-full">
            {actions.map((data, index) => {
                const isLast = index === actions.length - 1;
                const displayTime = data.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

                return (
                    <div key={data.id} className={`flex flex-col gap-1 w-full transition-all duration-300 ${!isLast ? 'opacity-60 grayscale-[40%]' : ''}`}>
                        <div className="flex items-center gap-2.5">
                            {isLast ? (
                                <Loader2 size={13} className="animate-spin text-blue-400 flex-shrink-0" />
                            ) : (
                                <CheckCircle2 size={13} className="text-green-500 flex-shrink-0" />
                            )}
                            <span className={`font-bold tracking-tight text-[11px] ${isLast ? 'text-blue-400' : 'text-gray-300'} flex items-center gap-1.5`}>
                                <span className="text-[10px] bg-white/5 px-1.5 py-0.5 rounded text-gray-400 font-mono">
                                    {displayTime}
                                </span>
                                <span>{data.action.replace('正在', isLast ? '正在' : '完毕: ')}</span>
                            </span>
                        </div>
                        {isLast && data.subStatus && (
                            <div className="text-[10px] text-gray-500 font-mono truncate max-w-[360px] pl-5.5 py-0.5 border-l border-white/5 ml-1.5 opacity-80 italic">
                                {data.subStatus}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// ─── Markdown CodeBlock ────────────────────────────────────────────────────────

function CodeBlock({ inline, className, children, node, ...props }: any) {
    const [copied, setCopied] = useState(false);
    const match = /language-(\w+)/.exec(className || '');
    const lang = match ? match[1] : '';

    // Detect inline code: either explicitly marked inline, or has no language class
    // and content is single-line (no newlines). In react-markdown v9+, `inline` may
    // not be passed, so we also check the parent node type.
    const isInline = inline || (!className && !String(children).includes('\n'));

    if (isInline) {
        return <code className="bg-gray-800 text-pink-300 rounded px-1.5 py-0.5 text-[12px] font-mono break-words" {...props}>{children}</code>;
    }

    const handleCopy = () => {
        navigator.clipboard.writeText(String(children).replace(/\n$/, ''));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="relative group rounded-md overflow-hidden bg-[#1E1E1E] my-3 border border-white/5">
            <div className="flex items-center justify-between px-3 py-1.5 bg-[#2D2D2D] text-gray-400 text-[10px] font-mono select-none">
                <span className="uppercase">{lang || 'text'}</span>
                <button
                    onClick={handleCopy}
                    className="hover:text-white transition-colors flex items-center gap-1 opacity-0 group-hover:opacity-100"
                >
                    {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                    <span className={copied ? "text-green-400" : ""}>{copied ? "Copied!" : "Copy"}</span>
                </button>
            </div>
            <pre className="p-4 m-0 overflow-x-auto text-[12px] font-mono custom-scrollbar text-gray-300">
                <code className={className} {...props}>{children}</code>
            </pre>
        </div>
    );
}

const MemoizedMessageGroup = memo(({
    group, isStreaming, isLastGroup, userAvatar, agentAvatar, displayName, effectiveModelDisplay, enableThinking
}: {
    group: Message[]; isStreaming: boolean; isLastGroup: boolean;
    userAvatar: string; agentAvatar: string; displayName: string; effectiveModelDisplay: string;
    enableThinking: boolean;
}) => {
    const isUser = group[0].role === 'user';
    const firstMsg = group[0];
    const lastMsg = group[group.length - 1];

    let finalContent = "";

    type Step = { type: 'think' | 'tool' | 'text', content: string };
    const steps: Step[] = [];

    let isActivelyWorkingWithoutText = false;

    if (!isUser) {
        group.forEach((msg) => {
            let text = msg.content || "";
            let reasoning = msg.reasoning_content || "";

            if (msg.role === 'assistant') {
                const thinkMatch = text.match(/<think>([\s\S]*?)(?:<\/think>|$)/i);
                if (thinkMatch) {
                    reasoning += thinkMatch[1];
                    text = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/i, "").trim();
                }

                if (reasoning && enableThinking) {
                    steps.push({ type: 'think', content: reasoning });
                }

                if (text) {
                    if (finalContent) finalContent += '\n\n';
                    finalContent += text;
                }

            } else if (msg.role === 'tool') {
                steps.push({ type: 'tool', content: msg.content || '(empty output)' });
            }
        });

        isActivelyWorkingWithoutText = Boolean(isStreaming && isLastGroup && !finalContent && steps.length === 0 && lastMsg.logs && lastMsg.logs.length > 0);
    } else {
        finalContent = firstMsg.content || "";
    }

    const showBubble = isUser || finalContent || steps.length > 0 || (!isActivelyWorkingWithoutText);
    const hasIntermediate = steps.length > 0;

    return (
        <div className={`flex gap-5 max-w-3xl mx-auto items-end ${isUser ? 'flex-row-reverse' : ''}`}>
            <AvatarDisplay
                src={isUser ? userAvatar : agentAvatar}
                alt={firstMsg.role}
                size="md"
            />
            <div className={`flex flex-col flex-1 min-w-0 ${isUser ? 'items-end' : 'items-start'}`}>

                {showBubble && (
                    <div className={`p-3.5 rounded-2xl text-sm leading-relaxed break-words max-w-[90%] ${isUser
                        ? 'bg-[#1E293B] border border-white/5 text-gray-100 rounded-tr-sm'
                        : 'bg-black/30 border border-white/5 rounded-tl-sm markdown-body'
                        } min-h-[38px] w-full`}>
                        {isUser ? (
                            <div className="whitespace-pre-wrap">{finalContent}</div>
                        ) : (
                            <>
                                {hasIntermediate && (
                                    <details className={`opacity-90 text-[12px] bg-black/20 rounded-xl border border-white/5 group/outer overflow-hidden ${finalContent ? 'mb-3' : ''}`} open={isLastGroup && isStreaming && !finalContent}>
                                        <summary className="cursor-pointer hover:bg-white/5 transition-colors select-none flex items-center gap-2 px-3.5 py-2.5 text-gray-400 font-medium">
                                            <Loader2 size={13} className={isLastGroup && isStreaming && !finalContent ? "animate-spin text-blue-400" : "hidden"} />
                                            <span className="flex-1 text-left">中间执行过程 ({steps.length})</span>
                                            <ChevronRight size={12} className="text-gray-600 transition-transform duration-200 group-open/outer:rotate-90" />
                                        </summary>
                                        <div className="flex flex-col px-3.5 pb-3.5 text-gray-400/80 border-t border-white/5 mt-0.5 pt-3 leading-relaxed max-h-[600px] overflow-y-auto custom-scrollbar">
                                            {steps.map((step, idx) => (
                                                <div key={idx} className="mb-3 last:mb-0">
                                                    {step.type === 'think' ? (
                                                        <div className="bg-white/5 rounded-lg p-3 border border-white/5">
                                                            <div className="flex items-center gap-2 mb-2 text-[10px] text-gray-500 font-bold uppercase tracking-wider">
                                                                <Brain size={10} className="text-purple-400" />
                                                                <span>Thinking Process</span>
                                                            </div>
                                                            <div className="whitespace-pre-wrap text-gray-400/80 italic leading-relaxed">
                                                                {step.content}
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <details className="group/tool overflow-hidden rounded-lg border border-white/10 bg-black/30 transition-all duration-300">
                                                            <summary className="flex cursor-pointer select-none items-center justify-between p-2 bg-white/5 hover:bg-white/10 transition-colors">
                                                                <div className="flex items-center gap-1.5 text-[10px] text-gray-500 font-mono">
                                                                    <Terminal size={10} />
                                                                    <span>Tool Output</span>
                                                                </div>
                                                                <ChevronRight size={10} className="text-gray-600 transition-transform duration-200 group-open/tool:rotate-90" />
                                                            </summary>
                                                            <div className="px-2.5 pb-2.5 pt-2 text-[10px] text-gray-400 font-mono whitespace-pre-wrap break-words opacity-90 max-h-64 overflow-y-auto custom-scrollbar border-t border-white/5 bg-black/40">
                                                                {step.content}
                                                            </div>
                                                        </details>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </details>
                                )}

                                {finalContent && (
                                    <ReactMarkdown
                                        remarkPlugins={[remarkGfm, remarkBreaks]}
                                        components={{ code: CodeBlock as any }}
                                        className="prose prose-invert prose-sm max-w-none text-[13px] leading-relaxed break-words mt-1"
                                    >
                                        {finalContent}
                                    </ReactMarkdown>
                                )}

                                {!finalContent && !hasIntermediate && (!isStreaming || !lastMsg.logs || lastMsg.logs.length === 0) && !lastMsg.tool_calls && (
                                    <div className="flex items-center gap-2 italic text-gray-500/50 text-[10px] px-2 py-1 rounded border border-dashed border-white/5 bg-black/10 select-none">
                                        <span className="w-1.5 h-1.5 rounded-full bg-gray-500/30"></span>
                                        No output generated
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                )}

                <div className={`flex flex-col mt-1.5 px-1 ${isUser ? 'items-end' : 'items-start'}`}>
                    <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-tight">
                            {isUser ? 'You' : displayName}
                        </span>
                        {firstMsg.timestamp && (
                            <span className="text-[9px] text-gray-400/80 tabular-nums">
                                · {new Date(firstMsg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </span>
                        )}
                        {!isUser && effectiveModelDisplay && (
                            <span className="text-[9px] text-gray-500/80 font-mono">
                                · {effectiveModelDisplay}
                            </span>
                        )}
                    </div>
                </div>

                {/* Render the ToolActionDisplay completely outside of the bubble */}
                {!isUser && isLastGroup && isStreaming && (
                    <div className={showBubble ? "mt-3" : ""}>
                        <ToolActionDisplay logs={lastMsg.logs || []} />
                    </div>
                )}
            </div>
        </div>
    );
}, (prevProps, nextProps) => {
    if (prevProps.isLastGroup !== nextProps.isLastGroup) return false;
    if (prevProps.isStreaming !== nextProps.isStreaming) return false;
    if (prevProps.group.length !== nextProps.group.length) return false;
    for (let i = 0; i < prevProps.group.length; i++) {
        const p = prevProps.group[i];
        const n = nextProps.group[i];
        if (p.content !== n.content) return false;
        if (p.role !== n.role) return false;
        if (p.timestamp !== n.timestamp) return false;
        if (p.logs !== n.logs && JSON.stringify(p.logs) !== JSON.stringify(n.logs)) return false;
    }
    return true;
});

// ─── Slash Commands Registry ────────────────────────────────────────────────
const SLASH_COMMANDS = [
    { cmd: '/new', args: '[name]', desc: '新建会话', detail: '创建一个新的聊天会话。可选参数 name 指定会话名称，不填则自动生成。' },
    { cmd: '/restart', args: '', desc: '重启会话', detail: '重置并清空当前会话，触发 Agent 重新读取最新的身份信息库和记忆。' },
    { cmd: '/stop', args: '', desc: '停止生成', detail: '立即中断当前正在进行的 AI 回复生成。' },
    { cmd: '/save', args: '[topic]', desc: '保存记忆', detail: '让 Agent 将本次对话中的关键信息保存到记忆文件中（MEMORY.md / USER.md 等）。可选参数指定要保存的主题范围。' },
    { cmd: '/clear', args: '', desc: '清空消息', detail: '清空当前会话的所有消息记录和摘要（不删除会话本身）。' },
    { cmd: '/help', args: '', desc: '帮助', detail: '显示所有可用斜杠命令的列表和说明。' },
];

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
    const [config, setConfig] = useState<any>(null);
    const [agents, setAgents] = useState<Agent[]>([]);
    const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set(['defaults']));
    const [agentSessions, setAgentSessions] = useState<Record<string, Session[]>>({});

    // Active chat state
    const [activeAgent, setActiveAgent] = useState<string | null>(null);
    const [activeSession, setActiveSession] = useState<string | null>(null);
    const currentChatRef = useRef({ agent: activeAgent, session: activeSession });
    currentChatRef.current = { agent: activeAgent, session: activeSession };

    const [messages, setMessages] = useState<Message[]>([]);
    const [sessionSummary, setSessionSummary] = useState('');
    const [sessionModel, setSessionModel] = useState('');  // per-session model override
    const [agentContext, setAgentContext] = useState('');  // system prompt preview

    const [input, setInput] = useState('');
    const [isGatewayRunning, setIsGatewayRunning] = useState(false);
    const [isStreaming, setIsStreaming] = useState(false);
    const [streamingSessions, setStreamingSessions] = useState<Record<string, boolean>>({});
    const [messageQueue, setMessageQueue] = useState<string[]>([]); // New state for message queue
    const [isScheduling, setIsScheduling] = useState(false); // Scheduling state
    const [scheduleSeconds, setScheduleSeconds] = useState(60);
    const [isRecurring, setIsRecurring] = useState(false);
    const [scheduledTasks, setScheduledTasks] = useState<any[]>([]);
    const [showScheduledTasks, setShowScheduledTasks] = useState(false);

    const [isSessionLoading, setIsSessionLoading] = useState(false);
    const [slashIdx, setSlashIdx] = useState(0);
    const [sidebarTab, setSidebarTab] = useState<SidebarTab>('agents');

    const [usePicoclaw, setUsePicoclaw] = useState(true);
    const [agentAvatar, setAgentAvatar] = useState<string>('🤖');
    const [userAvatar, setUserAvatar] = useState<string>(
        () => localStorage.getItem('picoclaw_user_avatar') || '🧑‍💻'
    );
    const lastCronFinishRef = useRef<Record<string, number>>({});
    const [expandedSettings, setExpandedSettings] = useState<Set<string>>(new Set(['avatars', 'agent']));
    const agentAvatarInputRef = useRef<HTMLInputElement>(null);
    const avatarCacheRef = useRef<Record<string, string>>({});
    const sessionCacheRef = useRef<Record<string, Message[]>>({});
    const userAvatarInputRef = useRef<HTMLInputElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const chatContainerRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const isSessionSwitching = useRef(false);  // controls scroll behaviour
    const [isAutoScroll, setIsAutoScroll] = useState(true);

    // Input history (ArrowUp/ArrowDown to browse)
    const inputHistoryRef = useRef<string[]>([]);
    const historyIdxRef = useRef(-1);     // -1 = not browsing history
    const historySavedRef = useRef('');    // saves current draft when entering history

    // Gateway Logs State
    const [gatewayLogsModal, setGatewayLogsModal] = useState(false);
    const [gatewayLogs, setGatewayLogs] = useState<string[]>([]);
    const gatewayLogsEndRef = useRef<HTMLDivElement>(null);

    // Modal States
    const [createAgentModal, setCreateAgentModal] = useState(false);
    const [createSessionAgentInput, setCreateSessionAgentInput] = useState<string | null>(null);
    const [deleteSessionModal, setDeleteSessionModal] = useState<{ agentKey: string, sessionKey: string } | null>(null);

    // Modal Input Refs/States
    const [newAgentName, setNewAgentName] = useState('');
    const [newAgentWorkspace, setNewAgentWorkspace] = useState('');
    const [newSessionName, setNewSessionName] = useState('');
    const [newSessionModel, setNewSessionModel] = useState('');

    // Toast Notifications State
    interface Toast {
        id: number;
        message: string;
        type: 'success' | 'error' | 'info';
    }
    const [toasts, setToasts] = useState<Toast[]>([]);

    const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
        const id = Date.now() + Math.random();
        setToasts(prev => [...prev, { id, message, type }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
    };

    // Custom Provider State
    const [createProviderModal, setCreateProviderModal] = useState(false);
    const [newProviderId, setNewProviderId] = useState('');
    const [newProviderBaseUrl, setNewProviderBaseUrl] = useState('');
    const [newProviderApiKey, setNewProviderApiKey] = useState('');
    // Removed newProviderModels

    // Model Repository State
    const [createModelModal, setCreateModelModal] = useState(false);
    const [editModelIndex, setEditModelIndex] = useState<number | null>(null);
    const [newModelConfig, setNewModelConfig] = useState<any>({
        id: '', provider: '', displayName: '', context_window: 128000, max_output_tokens: 16384,
        temperature: 0.6, top_p: 0.95, top_k: 20, presence_penalty: 0, repetition_penalty: 1, enable_thinking: false
    });

    // Agent Identity Editor State
    const [agentIdentityFiles, setAgentIdentityFiles] = useState<Record<string, string>>({});
    const [editingIdentityFile, setEditingIdentityFile] = useState<string | null>(null);
    const [isSavingIdentity, setIsSavingIdentity] = useState(false);

    const toggleSection = (id: string) => {
        setExpandedSettings(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    // ── Effects ────────────────────────────────────────────────────────────────

    useEffect(() => {
        fetchStatus();
        fetchConfig();
        fetchAgents();
        const int = setInterval(fetchStatus, 5000);
        return () => clearInterval(int);
    }, []);

    useEffect(() => {
        if (!activeAgent) return;
        const found = agents.find(a => a.key === activeAgent);
        if (found?.avatar) {
            setAgentAvatar(found.avatar);
            avatarCacheRef.current[activeAgent] = found.avatar;
        }
    }, [activeAgent, agents]);

    useEffect(() => {
        if (activeAgent && activeSession) {
            loadSession(activeAgent, activeSession);
        } else if (activeAgent) {
            // Meta only for settings
            fetch(`${API}/api/agents/${encodeURIComponent(activeAgent)}/meta`)
                .then(r => r.json())
                .catch(() => { });
        }
    }, [activeAgent, activeSession]);

    useEffect(() => {
        if (isAutoScroll) {
            messagesEndRef.current?.scrollIntoView({
                behavior: (isSessionSwitching.current || isStreaming) ? 'auto' : 'smooth'
            });
        }
        // Delay resetting the flag to let the browser paint the instant scroll 
        // before subsequent static inputs fall back to smooth scrolling.
        setTimeout(() => {
            isSessionSwitching.current = false;
        }, 50);
    }, [messages, isAutoScroll, isStreaming]);

    // ── Auto-polling for recovered sessions ────────────────────────────────────
    useEffect(() => {
        let interval: NodeJS.Timeout;
        // If we are streaming but abortControllerRef is NOT set, it means we recovered
        // this state from the backend (is_active) after a refresh. We need to poll
        // the session to see when it finishes so we can display the final message.
        if (isStreaming && activeAgent && activeSession && !abortControllerRef.current) {
            interval = setInterval(async () => {
                try {
                    const res = await fetch(`${API}/api/agents/${encodeURIComponent(activeAgent)}/sessions/${encodeURIComponent(activeSession)}`);
                    const data = await res.json();
                    if (!data.is_active && currentChatRef.current.session === activeSession) {
                        setMessages(data.messages || []);
                        setIsStreaming(false);
                        setStreamingSessions(prev => ({ ...prev, [`${activeAgent}:${activeSession}`]: false }));
                    }
                } catch (e) { }
            }, 3000);
        }
        return () => { if (interval) clearInterval(interval); }
    }, [isStreaming, activeAgent, activeSession]);

    useEffect(() => {
        let int: NodeJS.Timeout;
        if (gatewayLogsModal) {
            const fetchLogs = async () => {
                try {
                    const res = await fetch(`${API}/api/gateway/logs`);
                    const data = await res.json();
                    setGatewayLogs(data.logs || []);
                } catch (e) { }
            };
            fetchLogs();
            int = setInterval(fetchLogs, 1500);
        }
        return () => clearInterval(int);
    }, [gatewayLogsModal]);

    useEffect(() => {
        if (gatewayLogsModal && gatewayLogsEndRef.current) {
            gatewayLogsEndRef.current.scrollIntoView({ behavior: 'auto' });
        }
    }, [gatewayLogs]);

    // ── API helpers ────────────────────────────────────────────────────────────

    const fetchStatus = async () => {
        try {
            const res = await fetch(`${API}/api/gateway/status`);
            setIsGatewayRunning((await res.json()).running);
        } catch (e) { }
    };

    const fetchConfig = async () => {
        try { setConfig(await (await fetch(`${API}/api/config`)).json()); }
        catch (e) { }
    };


    const handleCreateProviderSubmit = () => {
        if (!newProviderId || !config) return;

        const id = newProviderId.toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (!id) return;

        const nc = { ...config };
        if (!nc.providers) nc.providers = {};
        nc.providers[id] = {
            api_base: newProviderBaseUrl,
            api_key: newProviderApiKey
        };

        setConfig(nc);
        setCreateProviderModal(false);
        // Reset inputs
        setNewProviderId('');
        setNewProviderBaseUrl('');
        setNewProviderApiKey('');
        // Force an autosave
        fetch(`${API}/api/config`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(nc)
        });
    };

    const handleModelSubmit = () => {
        if (!newModelConfig.id || !newModelConfig.provider || !config) return;

        const nc = { ...config };
        if (!nc.models) nc.models = [];

        if (editModelIndex !== null && editModelIndex >= 0) {
            nc.models[editModelIndex] = { ...newModelConfig };
        } else {
            nc.models.push({ ...newModelConfig });
        }

        setConfig(nc);
        setCreateModelModal(false);
        setEditModelIndex(null);
        setNewModelConfig({ id: '', provider: '', displayName: '', context_window: 128000, max_output_tokens: 16384, temperature: 0.6, top_p: 0.95, top_k: 20, presence_penalty: 0, repetition_penalty: 1, enable_thinking: false });

        fetch(`${API}/api/config`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(nc)
        });
    };

    const fetchAgents = async () => {
        try {
            const data: Agent[] = await (await fetch(`${API}/api/agents`)).json();
            setAgents(data);
            if (!activeAgent && data.length > 0) {
                // Default to the first agent + auto-select 'agent:main:main' session
                const firstKey = data[0].key;
                setActiveAgent(firstKey);
                fetchAgentIdentity(firstKey);
                (async () => {
                    await fetchAgentSessions(firstKey);
                    const sessions: Session[] = await (await fetch(`${API}/api/agents/${encodeURIComponent(firstKey)}/sessions`)).json();
                    const mainSess = sessions.find(s => s.key === `agent:${firstKey}:main`);
                    if (mainSess) {
                        setActiveSession(mainSess.key);
                    } else if (sessions.length > 0) {
                        setActiveSession(sessions[0].key);
                    }
                })();
            }
            for (const a of data) {
                fetchAgentSessions(a.key);
            }
        } catch (e) { }
    };

    const handleDeleteModel = async (index: number) => {
        if (!confirm('Delete this model?')) return;
        const nc = { ...config };
        if (nc.models && nc.models.length > index) {
            nc.models.splice(index, 1);
            setConfig(nc);
            fetch(`${API}/api/config`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(nc)
            });
        }
    };

    const fetchAgentSessions = async (agentKey: string) => {
        try {
            const data = await (await fetch(`${API}/api/agents/${encodeURIComponent(agentKey)}/sessions`)).json();
            setAgentSessions(prev => ({ ...prev, [agentKey]: data }));
        } catch (e) { }
    };

    const fetchAgentIdentity = async (agentKey: string) => {
        try {
            const data = await (await fetch(`${API}/api/agents/${encodeURIComponent(agentKey)}/identity`)).json();
            setAgentIdentityFiles(data);
            // Automatically select the first file if available
            if (Object.keys(data).length > 0 && !editingIdentityFile) {
                setEditingIdentityFile(Object.keys(data)[0]);
            }
        } catch (e) {
            setAgentIdentityFiles({});
            setEditingIdentityFile(null);
        }
    };

    const handleSaveIdentityFile = async () => {
        if (!activeAgent || !editingIdentityFile) return;
        setIsSavingIdentity(true);
        try {
            await fetch(`${API}/api/agents/${encodeURIComponent(activeAgent)}/identity`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename: editingIdentityFile,
                    content: agentIdentityFiles[editingIdentityFile]
                })
            });
            // Optional: Show a brief success toast/indicator
        } catch (e) {
            showToast('保存失败', 'error');
        } finally {
            setIsSavingIdentity(false);
        }
    };

    const loadSession = async (agentKey: string, sessionKey: string) => {
        const cacheKey = `${agentKey}:${sessionKey}`;
        // flushSync forces React to paint the loading state immediately,
        // preventing React 18 batching from skipping the spinner on fast local fetches
        flushSync(() => {
            setIsSessionLoading(true);
        });
        setIsAutoScroll(true);
        setIsStreaming(false); // Reset streaming state when switching sessions

        // Optimistically load from memory cache if available (prevents flash of empty screen while generating)
        if (sessionCacheRef.current[cacheKey]) {
            setMessages(sessionCacheRef.current[cacheKey]);
        }

        try {
            const res = await fetch(`${API}/api/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionKey)}`);
            const data = await res.json();

            // Critical fix: If user navigated away during fetch, abort state updates!
            if (currentChatRef.current.session !== sessionKey) return;

            // Recover streaming state if backend still processing
            if (data.is_active) {
                setIsStreaming(true);
                setStreamingSessions(prev => ({ ...prev, [`${agentKey}:${sessionKey}`]: true }));
                const currentMsgs = data.messages || [];
                // Append a spinner placeholder if the last message is from the user
                if (currentMsgs.length > 0 && currentMsgs[currentMsgs.length - 1].role === 'user') {
                    setMessages([...currentMsgs, { role: 'assistant', content: '', logs: [] }]);
                } else {
                    setMessages(currentMsgs);
                }
            } else if (!sessionCacheRef.current[cacheKey] || data.messages?.length >= sessionCacheRef.current[cacheKey].length) {
                setMessages(data.messages || []);
            }

            sessionCacheRef.current[cacheKey] = data.messages || [];
            setSessionSummary(data.summary || '');
            setSessionModel(data.webui_model || '');
        } catch (e) {
            if (currentChatRef.current.session === sessionKey) {
                setMessages([]); setSessionSummary('');
            }
        }

        if (currentChatRef.current.session !== sessionKey) return;

        // Avatar is managed by the sync effect using the 'agents' list
        try {
            await (await fetch(`${API}/api/agents/${encodeURIComponent(agentKey)}/meta`)).json();
        } catch (e) { }

        if (currentChatRef.current.session !== sessionKey) return;

        // Load agent context for display
        try {
            const ctx = await (await fetch(`${API}/api/agents/${encodeURIComponent(agentKey)}/context`)).json();
            if (currentChatRef.current.session !== sessionKey) return;
            setAgentContext(ctx.systemPrompt || '');
        } catch (e) {
            if (currentChatRef.current.session === sessionKey) setAgentContext('');
        }

        setIsSessionLoading(false);
        // Scroll to bottom instantly after all data is loaded and rendered
        isSessionSwitching.current = true;
        // Use requestAnimationFrame to ensure the DOM has rendered the messages
        requestAnimationFrame(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
            setTimeout(() => { isSessionSwitching.current = false; }, 50);
        });
    };

    const saveConfig = async () => {
        try {
            await fetch(`${API}/api/config`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });
            showToast('配置已保存！', 'success');
        } catch (e) { showToast('保存失败', 'error'); }
    };

    const handleCreateAgentSubmit = async () => {
        if (!newAgentName || !newAgentWorkspace) return;
        setCreateAgentModal(false);
        try {
            await fetch(`${API}/api/agents`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: newAgentName, workspace: newAgentWorkspace, model: config?.agents?.defaults?.model || '' })
            });
            await fetchAgents();
            await fetchConfig();
            setNewAgentName('');
            setNewAgentWorkspace('');
        } catch (e) { showToast('创建失败', 'error'); }
    };

    const handleCreateSessionSubmit = async () => {
        if (!createSessionAgentInput || !newSessionName) return;
        const agentKey = createSessionAgentInput;
        setCreateSessionAgentInput(null);
        // Ensure PicoClaw-compatible session key format
        const agentKeyForSession = createSessionAgentInput || activeAgent || 'main';
        const sessionKey = newSessionName.startsWith('agent:') ? newSessionName : `agent:${agentKeyForSession}:${newSessionName.replace(/[^a-zA-Z0-9_\-]/g, '_')}`;
        try {
            await fetch(`${API}/api/agents/${encodeURIComponent(agentKey)}/sessions`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: sessionKey, model: newSessionModel })
            });
            await fetchAgentSessions(agentKey);
            setActiveAgent(agentKey);
            setActiveSession(sessionKey);
            setNewSessionName('');
            setNewSessionModel('');
        } catch (e) { showToast('创建失败', 'error'); }
    };

    const handleDeleteSessionConfirm = async () => {
        if (!deleteSessionModal) return;
        const { agentKey, sessionKey } = deleteSessionModal;
        setDeleteSessionModal(null);
        try {
            const res = await fetch(`${API}/api/agents/${encodeURIComponent(agentKey)}/sessions/${encodeURIComponent(sessionKey)}`, {
                method: 'DELETE'
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Server error');
            }
            await fetchAgentSessions(agentKey);
            // If we deleted the active session, clear the chat
            if (activeAgent === agentKey && activeSession === sessionKey) {
                setActiveSession(null);
                setMessages([]);
                setSessionSummary('');
            }
        } catch (e: any) { showToast('删除失败: ' + e.message, 'error'); }
    };

    const toggleGateway = async () => {
        const action = isGatewayRunning ? 'stop' : 'start';
        try {
            const data = await (await fetch(`${API}/api/gateway/${action}`, { method: 'POST' })).json();
            if (!data.success && data.error) showToast('Gateway 启动失败：\n' + data.error, 'error');
            fetchStatus();
        } catch (e) { showToast('无法与后台通信', 'error'); }
    };

    const persistMessage = async (role: string, content: string) => {
        if (!activeAgent || !activeSession) return;
        try {
            await fetch(`${API}/api/agents/${encodeURIComponent(activeAgent)}/sessions/${encodeURIComponent(activeSession)}/message`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role, content })
            });
        } catch (e) { }
    };

    const updateSessionModel = async (model: string) => {
        if (!activeAgent || !activeSession) return;
        setSessionModel(model);
        try {
            await fetch(`${API}/api/agents/${encodeURIComponent(activeAgent)}/sessions/${encodeURIComponent(activeSession)}/model`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model })
            });
        } catch (e) { }
    };

    const updateAgentMeta = async (updates: any) => {
        if (!activeAgent) return;
        try {
            const res = await fetch(`${API}/api/agents/${encodeURIComponent(activeAgent)}/meta`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            });
            const data = await res.json();
            if (data.success) {
                // Refresh agents list to reflect changes in UI
                fetchAgents();
            }
        } catch (e) { console.error('Failed to update agent meta:', e); }
    };

    const uploadAvatar = async (type: 'agent' | 'user', file: File) => {
        const formData = new FormData();
        formData.append('avatar', file);
        try {
            if (type === 'agent' && activeAgent) {
                const data = await (await fetch(`${API}/api/agents/${encodeURIComponent(activeAgent)}/avatar`, { method: 'POST', body: formData })).json();
                if (data.success) {
                    const url = `${API}${data.url}?t=${Date.now()}`;
                    setAgentAvatar(url);
                    // Refresh agent list to update sidebar avatars
                    fetchAgents();
                }
            } else {
                const data = await (await fetch(`${API}/api/avatar/user`, { method: 'POST', body: formData })).json();
                if (data.success) {
                    const url = `${API}${data.url}?t=${Date.now()}`;
                    setUserAvatar(url);
                    localStorage.setItem('picoclaw_user_avatar', url);
                }
            }
        } catch (e) { }
    };

    // ── Resolve effective model for current session ────────────────────────────

    const getEffectiveModel = () => {
        // Session model > Agent default model > global default
        const raw = sessionModel || agents.find(a => a.key === activeAgent)?.model || config?.agents?.defaults?.model || '';
        return raw;
    };

    // ── Send message ───────────────────────────────────────────────────────────

    // Watch for stream end to process queue
    useEffect(() => {
        if (!isStreaming && messageQueue.length > 0) {
            const nextMsg = messageQueue[0];
            setMessageQueue(prev => prev.slice(1));
            // Small delay to ensure state updates settle
            setTimeout(() => {
                handleSend(nextMsg);
            }, 300);
        }
    }, [isStreaming]);

    const handleSend = async (overrideMsg?: string, options: { isHidden?: boolean } = {}) => {
        let userMsg = overrideMsg !== undefined ? overrideMsg : input.trim();
        if (!userMsg && !isStreaming) return; // Allow empty msg only for stop button if streaming
        if (!activeAgent || !activeSession) return;

        // ── Slash Commands Interception ──
        if (userMsg.startsWith('/save')) {
            const optionalTopic = userMsg.slice(5).trim();
            userMsg = `[SYSTEM COMMAND (DO NOT READ ALOUD)]: Please summarize the key information, facts, user preferences, and important context from our recent conversation${optionalTopic ? ` specifically regarding "${optionalTopic}"` : ''}. Review your tools and use the file writing tool to append or update your configuration files as appropriate: \`memory/MEMORY.md\` (for facts and long-term memory), \`USER.md\` (for user preferences/persona), \`IDENTITY.md\` / \`SOUL.md\` / \`AGENT.md\` (if core identity or behavior rules changed), or \`TOOLS.md\` (for tool usage notes). Ensure you don't forget this in future sessions. Then reply to me briefly confirming what you saved.`;
        }
        if (userMsg === '/stop') {
            setInput('');
            if (textareaRef.current) textareaRef.current.style.height = 'auto';
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
                abortControllerRef.current = null;
            }
            setIsStreaming(false);
            setStreamingSessions(prev => ({ ...prev, [`${activeAgent}:${activeSession}`]: false }));

            try {
                await fetch(`${API}/api/chat/stop`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ agentKey: activeAgent, sessionKey: activeSession })
                });
                setMessages(m => [...m, { role: 'assistant', content: '🛑 生成已手动中止。' }]);
            } catch (e) {
                console.error("Failed to stop session", e);
            }
            return;
        }

        if (userMsg.startsWith('/new')) {
            setInput('');
            if (textareaRef.current) textareaRef.current.style.height = 'auto';
            const nameParam = userMsg.slice(4).trim();
            // Use PicoClaw CLI-compatible session key format: agent:{agentKey}:{name}
            const safeName = (nameParam || ('chat_' + Date.now())).replace(/[^a-zA-Z0-9_\-]/g, '_');
            const sessionKey = `agent:${activeAgent}:${safeName}`;
            try {
                const res = await fetch(`${API}/api/agents/${encodeURIComponent(activeAgent)}/sessions`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: sessionKey, model: '' })
                });
                const data = await res.json();
                await fetchAgentSessions(activeAgent);
                setActiveSession(data.key || sessionKey);

                // Send system prompt to trigger greeting reading context (HIDDEN)
                const systemPrompt = `[SYSTEM COMMAND (DO NOT READ ALOUD)]: 本次对话已被重置。请在后台重新读取你的 \`IDENTITY.md\`、\`SOUL.md\`、\`AGENT.md\`、\`USER.md\` 以及 \`MEMORY.md\` 文件设定，以此重新构建你当下的人设。理解完成后，以第一人称主动向我打个招呼，说句好听的话。`;

                setMessages([{ role: 'assistant', content: '✅ 已创建新会话并同步身份信息。', logs: [] }]);

                setTimeout(() => {
                    handleSend(systemPrompt, { isHidden: true });
                }, 500);
            } catch (e) {
                console.error("Failed to create session via /new", e);
            }
            return;
        }

        if (userMsg === '/clear') {
            setInput('');
            if (textareaRef.current) textareaRef.current.style.height = 'auto';
            setMessages([]);
            setSessionSummary('');
            return;
        }

        if (userMsg === '/restart') {
            setInput('');
            if (textareaRef.current) textareaRef.current.style.height = 'auto';
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
                abortControllerRef.current = null;
            }
            setIsStreaming(false);

            try {
                // Completely wipe local cache to prevent pessimistic UI reload from restoring deleted state
                const cacheKey = `${activeAgent}:${activeSession}`;
                delete sessionCacheRef.current[cacheKey];
                setMessages([]);
                setSessionSummary('');

                // Stop any running backend generation process for this session
                await fetch(`${API}/api/chat/stop`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionKey: activeSession })
                }).catch(() => { });

                // Delete current session
                await fetch(`${API}/api/agents/${encodeURIComponent(activeAgent)}/sessions/${encodeURIComponent(activeSession)}`, {
                    method: 'DELETE'
                });

                // Recreate session with same key
                await fetch(`${API}/api/agents/${encodeURIComponent(activeAgent)}/sessions`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: activeSession, model: '' })
                });

                // Reload the cleared state
                await fetchAgentSessions(activeAgent);

                // Send system prompt to trigger greeting reading context
                const systemPrompt = `[SYSTEM COMMAND (DO NOT READ ALOUD)]: 本次对话已被重置。请在后台重新读取你的 \`IDENTITY.md\`、\`SOUL.md\`、\`AGENT.md\`、\`USER.md\` 以及 \`MEMORY.md\` 文件设定，以此重新构建你当下的人设。理解完成后，以第一人称主动向我打个招呼，说句好听的话。`;

                // We fake a user message visually, but actually send the system command
                setMessages([{ role: 'assistant', content: '✅ 会话已彻底重启。身份信息和记忆已重新载入。', logs: [] }]);

                // Trigger the actual backend generation with the system prompt (HIDDEN)
                // We pass the prompt but handleSend will use its own state update logic
                setTimeout(() => {
                    handleSend(systemPrompt, { isHidden: true });
                }, 100);

            } catch (e) {
                console.error("Failed to restart session", e);
            }
            return;
        }

        if (userMsg === '/help') {
            setInput('');
            if (textareaRef.current) textareaRef.current.style.height = 'auto';
            const lines = [
                '### ⚡ 斜杠命令列表',
                '',
                '| 命令 | 参数 | 说明 |',
                '|------|------|------|',
                ...SLASH_COMMANDS.map(c => `| \`${c.cmd}\` | ${c.args ? '`' + c.args + '`' : '—'} | ${c.detail} |`),
                '',
                '> 💡 在输入框中输入 `/` 即可触发自动补全，用 ↑↓ 选择，Enter 或 Tab 确认。',
            ];
            setMessages(m => [...m, { role: 'assistant', content: lines.join('\n') }]);
            return;
        }

        if (isStreaming) {
            if (!userMsg) return;
            // Otherwise, queue the message
            setMessageQueue(prev => [...prev, userMsg]);
            setInput('');
            if (textareaRef.current) textareaRef.current.style.height = 'auto';
            return;
        }

        setInput('');
        if (textareaRef.current) textareaRef.current.style.height = 'auto'; // Reset textarea height
        setIsAutoScroll(true); // Always auto-scroll when user sends

        // Push to input history
        inputHistoryRef.current.push(userMsg);
        historyIdxRef.current = -1;
        historySavedRef.current = '';

        const timestamp = new Date().toISOString();
        const userMsgObj: Message = { role: 'user', content: userMsg, timestamp, isHidden: options.isHidden };

        if (currentChatRef.current.agent === activeAgent && currentChatRef.current.session === activeSession) {
            setMessages(prev => [...prev, userMsgObj]);
        }
        setIsStreaming(true);

        // Only persist manually if NOT using the picoclaw agent backend (which auto-saves)
        if (!usePicoclaw) {
            await persistMessage('user', userMsg);
        }

        abortControllerRef.current = new AbortController();

        const requestAgent = activeAgent;
        const requestSession = activeSession;

        try {
            const effectiveModel = getEffectiveModel();
            const providerName = effectiveModel.split('/')[0] || '';
            const providerCfg = config?.providers?.[providerName] || {};
            const apiKey = providerCfg.api_key || '';
            const apiBase = providerCfg.api_base || 'https://api.openai.com/v1';

            if (!apiKey) {
                const errMsg = `❌ 供应商 '${providerName}' 无 API Key，请在设置中填写后保存。`;
                if (currentChatRef.current.agent === requestAgent && currentChatRef.current.session === requestSession) {
                    setMessages(m => [...m, { role: 'assistant', content: errMsg }]);
                }
                if (!usePicoclaw) await persistMessage('assistant', errMsg);
                setIsStreaming(false);
                return;
            }

            const actualModel = effectiveModel;

            const agentCfg = config?.agents?.[activeAgent] || config?.agents?.defaults || {};

            const modelEntry = (config?.models || []).find((m: any) => {
                const fullId = `${m.provider}/${m.id}`;
                return fullId === actualModel || m.id === actualModel || m.displayName === actualModel;
            });
            setIsStreaming(true);
            setStreamingSessions(prev => ({ ...prev, [`${requestAgent}:${requestSession}`]: true }));

            let currentSessionMessages: Message[] = [];
            setMessages(prev => {
                const updated = [...prev, { role: 'assistant', content: '', logs: [] }];
                currentSessionMessages = updated;
                return updated;
            });

            const cacheKey = `${requestAgent}:${requestSession}`;
            if (requestSession) sessionCacheRef.current[cacheKey] = currentSessionMessages;

            const res = await fetch(`${API}/api/chat/stream`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                signal: abortControllerRef.current.signal,
                body: JSON.stringify({
                    agentKey: activeAgent,
                    sessionKey: activeSession,
                    messages: (usePicoclaw
                        ? [{ role: 'user', content: userMsg }]
                        : [...messages, { role: 'user', content: userMsg }]
                    ).map(m => ({
                        role: m.role,
                        content: m.content || "",
                        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
                        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {})
                    })),
                    model: actualModel,
                    apiKey,
                    apiBase,
                    maxTokens: modelEntry?.max_output_tokens || agentCfg.max_tokens || 8192,
                    temperature: modelEntry?.temperature ?? agentCfg.temperature ?? 0.7,
                    top_p: modelEntry?.top_p,
                    top_k: modelEntry?.top_k,
                    presence_penalty: modelEntry?.presence_penalty,
                    repetition_penalty: modelEntry?.repetition_penalty,
                    enable_thinking: modelEntry?.enable_thinking,
                    usePicoclaw,
                })
            });

            if (!res.body) throw new Error('No stream');
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let assistantMsg = '';
            let assistantReasoning = '';
            let assistantLogs: string[] = [];

            let lastRenderTime = Date.now();
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                const lines = decoder.decode(value, { stream: true }).split('\n').filter(l => l.trim());

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6);
                    if (raw === '[DONE]') continue;
                    try {
                        const d = JSON.parse(raw);
                        if (d.error) assistantMsg += `\n**Error:** ${d.error}`;
                        else if (d.reasoning_content) {
                            if (!assistantReasoning) assistantReasoning = '';
                            assistantReasoning += d.reasoning_content;
                        } else if (d.choices?.[0]?.delta?.content) {
                            assistantMsg += d.choices[0].delta.content;
                            // Strip out lobster emojis from picoclaw
                            assistantMsg = assistantMsg.replace(/🦞\s*/g, '');
                        }

                        if (d.tool_log) {
                            assistantLogs.push(d.tool_log);
                        }

                        currentSessionMessages = [
                            ...currentSessionMessages.slice(0, -1),
                            {
                                ...currentSessionMessages[currentSessionMessages.length - 1],
                                content: assistantMsg,
                                reasoning_content: assistantReasoning || undefined,
                                logs: assistantLogs.length > 0 ? assistantLogs : undefined,
                                timestamp: new Date().toISOString()
                            }
                        ];

                        if (requestSession && requestAgent) sessionCacheRef.current[`${requestAgent}:${requestSession}`] = currentSessionMessages;

                        const now = Date.now();
                        if (now - lastRenderTime > 100) {
                            lastRenderTime = now;
                            if (currentChatRef.current.agent === requestAgent && currentChatRef.current.session === requestSession) {
                                setMessages(prev => {
                                    const updated = [
                                        ...prev.slice(0, -1),
                                        {
                                            ...prev[prev.length - 1],
                                            content: assistantMsg,
                                            reasoning_content: assistantReasoning || undefined,
                                            logs: assistantLogs.length > 0 ? assistantLogs : undefined,
                                            timestamp: new Date().toISOString()
                                        }
                                    ];
                                    currentSessionMessages = updated;
                                    return updated;
                                });
                            }
                        }
                    } catch (e) { }
                }

                // Force a final guaranteed render after processing the entire batch
                if (currentChatRef.current.agent === requestAgent && currentChatRef.current.session === requestSession) {
                    setMessages(prev => {
                        const updated = [
                            ...prev.slice(0, -1),
                            {
                                ...prev[prev.length - 1],
                                content: assistantMsg,
                                reasoning_content: assistantReasoning || undefined,
                                logs: assistantLogs.length > 0 ? assistantLogs : undefined,
                                timestamp: new Date().toISOString()
                            }
                        ];
                        currentSessionMessages = updated;
                        return updated;
                    });
                }
            }

            if (assistantMsg && currentChatRef.current.agent === requestAgent && currentChatRef.current.session === requestSession) {
                if (!usePicoclaw) {
                    await persistMessage('assistant', assistantMsg);
                }
                fetchAgentSessions(activeAgent); // Trigger reload to update UI timestamps/messages
            }
        } catch (err) {
            // Only show error if we are still on the same chat
            if (currentChatRef.current.agent === requestAgent && currentChatRef.current.session === requestSession) {
                const errMsg = `**Network Error:** ${(err as Error).message}`;
                setMessages(prev => [...prev, { role: 'assistant', content: errMsg }]);
                if (!usePicoclaw) {
                    await persistMessage('assistant', errMsg);
                }
            }
        } finally {
            setStreamingSessions(prev => ({ ...prev, [`${requestAgent}:${requestSession}`]: false }));
            if (currentChatRef.current.agent === requestAgent && currentChatRef.current.session === requestSession) {
                setIsStreaming(false);
            }
        }
    };

    const fetchScheduledTasks = async () => {
        try {
            const res = await fetch(`${API}/api/cron`);
            if (res.ok) {
                const data = await res.json();
                setScheduledTasks(data);

                // Detect if any task has newly finished for the active session
                let needsRefresh = false;
                const currentAgent = currentChatRef.current.agent;
                const currentSession = currentChatRef.current.session;

                data.forEach((task: any) => {
                    if (task.lastFinishedAt && task.lastFinishedAt > (lastCronFinishRef.current[task.id] || 0)) {
                        lastCronFinishRef.current[task.id] = task.lastFinishedAt;
                        if (task.agentKey === currentAgent && task.sessionKey === currentSession) {
                            needsRefresh = true;
                        }
                    }
                });

                if (needsRefresh && currentAgent && currentSession) {
                    console.log('[Cron] Refreshing session due to task completion for', currentAgent);
                    loadSession(currentAgent, currentSession);
                }
            }
        } catch (e) { console.error('Failed to fetch tasks:', e); }
    };

    const handleCancelSchedule = async (id: string) => {
        try {
            const res = await fetch(`${API}/api/cron/${id}`, { method: 'DELETE' });
            if (res.ok) {
                showToast('Schedule cancelled.', 'success');
                fetchScheduledTasks();
            }
        } catch (e) { showToast('Failed to cancel schedule.', 'error'); }
    };

    useEffect(() => {
        fetchScheduledTasks();
        const timer = setInterval(fetchScheduledTasks, 30000); // Poll every 30s to save browser resources
        return () => clearInterval(timer);
    }, []);

    // Precise timeout pro-active trigger for exactly when the next task runs
    useEffect(() => {
        const timers: NodeJS.Timeout[] = [];
        scheduledTasks.forEach(task => {
            if (task.enabled && task.agentKey === activeAgent && task.sessionKey === activeSession && task.nextRun) {
                const delay = task.nextRun - Date.now() + 500; // +500ms to ensure backend has spoofed the process
                // Only set timers that will fire before the next 30s poll
                if (delay > 0 && delay < 32000) {
                    const timer = setTimeout(() => {
                        if (currentChatRef.current.agent === activeAgent && currentChatRef.current.session === activeSession) {
                            if (activeAgent && activeSession) {
                                loadSession(activeAgent, activeSession);
                            }
                        }
                    }, delay);
                    timers.push(timer);
                }
            }
        });
        return () => timers.forEach(clearTimeout);
    }, [scheduledTasks, activeAgent, activeSession]);

    const handleSchedule = async () => {
        if (!input.trim()) {
            showToast('Please type a message first before scheduling.', 'error');
            return;
        }
        if (!activeAgent || !activeSession) {
            showToast('Please select an agent and session first.', 'error');
            return;
        }

        try {
            const body = {
                name: `WebUI: ${input.slice(0, 20)}...`,
                message: input,
                every: isRecurring ? scheduleSeconds : null,
                at: isRecurring ? null : Date.now() + (scheduleSeconds * 1000),
                agentKey: activeAgent,
                sessionKey: activeSession,
                model: getEffectiveModel()
            };
            const res = await fetch(`${API}/api/cron`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (res.ok) {
                setInput('');
                setIsScheduling(false);
                showToast('Schedule set successfully!', 'success');
                fetchScheduledTasks(); // Refresh list
            } else {
                const err = await res.text();
                showToast(`Failed to set schedule: ${err}`, 'error');
            }
        } catch (e) {
            console.error('Failed to schedule:', e);
            showToast(`Failed to set schedule: ${e instanceof Error ? e.message : String(e)}`, 'error');
        }
    };

    // ── Render ─────────────────────────────────────────────────────────────────

    const activeAgentData = agents.find(a => a.key === activeAgent);
    const effectiveModelDisplay = getEffectiveModel();

    // Dynamically build model list from config.models or legacy config.providers
    const availableModels = useMemo(() => {
        if (!config) return [];

        // Use new global models array if it exists and is populated
        if (config.models && Array.isArray(config.models) && config.models.length > 0) {
            const grouped: Record<string, any[]> = {};
            config.models.forEach((m: any) => {
                const p = m.provider || 'default';
                if (!grouped[p]) grouped[p] = [];
                grouped[p].push({ value: `${p}/${m.id}`, label: m.displayName || m.id, config: m });
            });
            return Object.entries(grouped).map(([provider, models]) => ({ provider, models }));
        }

        // Fallback for old config structure
        if (!config.providers) return [];
        const list = [];
        for (const [provider, cfg] of Object.entries<any>(config.providers)) {
            if (cfg.models) {
                const arr = cfg.models.split(',').map((s: string) => s.trim()).filter(Boolean);
                if (arr.length > 0) {
                    list.push({ provider, models: arr.map((m: string) => ({ value: `${provider}/${m}`, label: m })) });
                }
            }
        }
        return list;
    }, [config]);



    const groupedMessages = useMemo(() => {
        const groups: Message[][] = [];
        for (const m of messages) {
            if (m.isHidden || (m.content && m.content.startsWith('[SYSTEM COMMAND (DO NOT READ ALOUD)]'))) continue;
            if (m.role === 'user') {
                groups.push([m]);
            } else {
                const last = groups[groups.length - 1];
                if (last && last[0].role !== 'user') {
                    last.push(m);
                } else {
                    groups.push([m]);
                }
            }
        }
        return groups;
    }, [messages]);

    return (
        <div className="flex h-screen overflow-hidden bg-[#0B1120] text-gray-100">

            {/* ===== Sidebar ===== */}
            <div className="w-72 bg-[#111827] border-r border-white/8 flex flex-col flex-shrink-0">

                {/* Logo */}
                <div className="px-4 py-4 border-b border-white/5 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center text-lg shadow-lg">🦐</div>
                    <div>
                        <h1 className="font-bold text-sm tracking-tight">PicoClaw</h1>
                        <p className="text-[10px] text-blue-400/70">Multi-Agent Dashboard</p>
                    </div>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-white/5">
                    {(['agents', 'settings'] as SidebarTab[]).map(tab => (
                        <button key={tab} onClick={() => setSidebarTab(tab)}
                            className={`flex-1 py-2 text-[11px] font-semibold flex items-center justify-center gap-1 transition-colors ${sidebarTab === tab ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-500 hover:text-gray-300'}`}>
                            {tab === 'agents' ? <><Brain size={11} /> Agents</> : <><Settings size={11} /> Settings</>}
                        </button>
                    ))}
                </div>

                {/* Sidebar content */}
                <div className="flex-1 overflow-y-auto">

                    {/* ── Agents tab ── */}
                    {sidebarTab === 'agents' && (
                        <div className="p-2 space-y-1">
                            {/* Gateway status */}
                            <div className={`p-2.5 rounded-lg border mb-2 ${isGatewayRunning ? 'bg-green-500/5 border-green-500/20' : 'bg-white/2 border-white/5'}`}>
                                <div className="flex items-center justify-between">
                                    <div className={`flex items-center gap-1.5 text-xs ${isGatewayRunning ? 'text-green-400' : 'text-gray-500'}`}>
                                        <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                                        <Terminal size={11} />
                                        <span>{isGatewayRunning ? 'Gateway Active' : 'Gateway Off'}</span>
                                    </div>
                                    <div className="flex gap-1.5">
                                        <button onClick={() => setGatewayLogsModal(true)}
                                            className="text-[10px] px-2 py-0.5 rounded font-medium transition-colors bg-gray-500/20 text-gray-400 hover:bg-gray-500/40 hover:text-white">
                                            Logs
                                        </button>
                                        <button onClick={toggleGateway}
                                            className={`text-[10px] px-2 py-0.5 rounded font-medium transition-colors ${isGatewayRunning ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30' : 'bg-blue-500/20 text-blue-300 hover:bg-blue-500/30'}`}>
                                            <Power size={10} className="inline mr-1" />{isGatewayRunning ? 'Stop' : 'Start'}
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Agent list */}
                            {agents.map(agent => {
                                const expanded = expandedAgents.has(agent.key);
                                const sessions = agentSessions[agent.key] || [];
                                return (
                                    <div key={agent.key}>
                                        {/* Agent header — shows per-agent avatar */}
                                        <div
                                            className={`flex items-center gap-3 px-2.5 py-3 rounded-lg cursor-pointer transition-colors group ${activeAgent === agent.key ? 'bg-blue-500/10' : 'hover:bg-white/4'}`}
                                            onClick={() => {
                                                setExpandedAgents(prev => {
                                                    const next = new Set(prev);
                                                    if (next.has(agent.key)) next.delete(agent.key); else next.add(agent.key);
                                                    return next;
                                                });
                                                if (activeAgent !== agent.key) {
                                                    setActiveAgent(agent.key);
                                                    setMessages([]);
                                                    setSessionSummary('');
                                                    fetchAgentIdentity(agent.key);
                                                    // Auto-select 'agent:main:main' or first available session
                                                    (async () => {
                                                        await fetchAgentSessions(agent.key);
                                                        const sessions: Session[] = await (await fetch(`${API}/api/agents/${encodeURIComponent(agent.key)}/sessions`)).json();
                                                        const mainSess = sessions.find(s => s.key === `agent:${agent.key}:main`);
                                                        if (mainSess) {
                                                            setActiveSession(mainSess.key);
                                                        } else if (sessions.length > 0) {
                                                            setActiveSession(sessions[0].key);
                                                        } else {
                                                            setActiveSession(null);
                                                        }
                                                    })();
                                                }
                                            }}
                                        >
                                            {/* Agent avatar */}
                                            <div className="w-9 h-9 rounded-lg overflow-hidden flex-shrink-0 flex items-center justify-center bg-gradient-to-br from-blue-500/20 to-violet-500/20 border border-blue-500/20 text-lg">
                                                <AvatarDisplay src={agent.avatar || '🤖'} alt={agent.key} size="sm" />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm font-semibold text-gray-200 truncate">{agent.displayName || agent.key}</div>
                                                <div className="text-xs text-gray-500">{sessions.length || agent.sessionCount} sessions</div>
                                            </div>
                                            {expanded ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
                                        </div>

                                        {/* Sessions under this agent */}
                                        {expanded && (
                                            <div className="ml-3 pl-3 border-l border-white/5 mt-0.5 space-y-0.5">
                                                {sessions.map(sess => {
                                                    const isActive = activeAgent === agent.key && activeSession === sess.key;
                                                    return (
                                                        <div key={sess.key} className={`group flex items-start rounded-lg transition-colors ${isActive ? 'bg-blue-500/20 border border-blue-500/30' : 'hover:bg-white/5'}`}>
                                                            <button
                                                                onClick={() => { setActiveAgent(agent.key); setActiveSession(sess.key); }}
                                                                className="flex-1 text-left px-2 py-1.5 min-w-0"
                                                            >
                                                                <div className="flex items-center gap-1.5">
                                                                    <MessageSquare size={10} className={isActive ? 'text-blue-400 flex-shrink-0' : 'text-gray-600 flex-shrink-0'} />
                                                                    <span className="text-[11px] text-gray-300 truncate flex-1">{sess.key}</span>
                                                                    <span className="text-[9px] text-gray-600">{sess.messageCount}msg</span>
                                                                </div>
                                                                {sess.model && (
                                                                    <div className="ml-3.5 text-[9px] text-blue-400/60 truncate mt-0.5">{sess.model.split('/').pop()}</div>
                                                                )}
                                                            </button>
                                                            {/* Delete button — visible on hover */}
                                                            <button
                                                                onClick={e => { e.stopPropagation(); setDeleteSessionModal({ agentKey: agent.key, sessionKey: sess.key }); }}
                                                                className="opacity-0 group-hover:opacity-100 px-1.5 py-2 text-gray-600 hover:text-red-400 transition-all flex-shrink-0"
                                                                title="删除 session"
                                                            >
                                                                ✕
                                                            </button>
                                                        </div>
                                                    );
                                                })}
                                                {/* New session button */}
                                                <button onClick={() => {
                                                    setNewSessionName(`agent:${agent.key}:web_${Date.now()}`);
                                                    setNewSessionModel(agents.find(a => a.key === agent.key)?.model || '');
                                                    setCreateSessionAgentInput(agent.key);
                                                }}
                                                    className="w-full text-left px-2 py-1.5 rounded-lg text-[11px] text-gray-500 hover:text-gray-300 hover:bg-white/5 flex items-center gap-1.5 transition-colors">
                                                    <Plus size={10} /> New Session
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}

                            {/* New agent button */}
                            <button onClick={() => {
                                setNewAgentName('');
                                setNewAgentWorkspace('~/.picoclaw/ws_new_agent');
                                setCreateAgentModal(true);
                            }}
                                className="w-full mt-2 py-2 rounded-lg text-[11px] text-gray-500 hover:text-gray-200 border border-dashed border-white/10 hover:border-white/20 flex items-center justify-center gap-1.5 transition-colors">
                                <Plus size={11} /> New Agent
                            </button>
                        </div>
                    )}

                    {/* ── Settings tab ── */}
                    {sidebarTab === 'settings' && (
                        <div className="p-3 space-y-2">

                            {/* Avatars */}
                            <div className="bg-black/20 rounded-xl border border-white/5 overflow-hidden">
                                <button
                                    onClick={() => toggleSection('avatars')}
                                    className="w-full px-3 py-2 flex items-center justify-between text-[10px] font-bold text-gray-400 uppercase tracking-wider hover:bg-white/5 transition-colors"
                                >
                                    <span>Avatars</span>
                                    {expandedSettings.has('avatars') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                </button>
                                {expandedSettings.has('avatars') && (
                                    <div className="p-3 pt-0 grid grid-cols-2 gap-3 text-center border-t border-white/5 mt-2">
                                        {/* Agent avatar */}
                                        <div>
                                            <label className="text-[9px] text-gray-500 mb-2 block uppercase">Agent</label>
                                            <button onClick={() => agentAvatarInputRef.current?.click()}
                                                className="w-12 h-12 mx-auto rounded-full border-2 border-dashed border-white/20 hover:border-blue-500/50 flex items-center justify-center bg-black/30 cursor-pointer group relative overflow-hidden transition-colors">
                                                <AvatarDisplay src={agentAvatar} alt="agent" size="sm" />
                                                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                                    <span className="text-[9px] text-white">Change</span>
                                                </div>
                                            </button>
                                            <input ref={agentAvatarInputRef} type="file" accept="image/*" className="hidden"
                                                onChange={e => { if (e.target.files?.[0]) uploadAvatar('agent', e.target.files[0]); }} />
                                            <p className="text-[8px] text-gray-600 mt-1">Workspace</p>
                                        </div>
                                        {/* User avatar */}
                                        <div>
                                            <label className="text-[9px] text-gray-500 mb-2 block uppercase">User</label>
                                            <button onClick={() => userAvatarInputRef.current?.click()}
                                                className="w-12 h-12 mx-auto rounded-full border-2 border-dashed border-white/20 hover:border-blue-500/50 flex items-center justify-center bg-black/30 cursor-pointer group relative overflow-hidden transition-colors">
                                                <AvatarDisplay src={userAvatar} alt="user" size="sm" />
                                                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                                    <span className="text-[9px] text-white">Change</span>
                                                </div>
                                            </button>
                                            <input ref={userAvatarInputRef} type="file" accept="image/*" className="hidden"
                                                onChange={e => { if (e.target.files?.[0]) uploadAvatar('user', e.target.files[0]); }} />
                                            <p className="text-[8px] text-gray-600 mt-1">Local</p>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Channels Data - config.channels */}
                            {config && config.channels && (
                                <div className="bg-black/20 rounded-xl border border-white/5 overflow-hidden">
                                    <button
                                        onClick={() => toggleSection('channels')}
                                        className="w-full px-3 py-2 flex items-center justify-between text-[10px] font-bold text-gray-400 uppercase tracking-wider hover:bg-white/5 transition-colors"
                                    >
                                        <div className="flex items-center gap-1.5">
                                            <Hash size={12} className={expandedSettings.has('channels') ? 'text-blue-400' : 'text-gray-500'} />
                                            <span>Channels</span>
                                        </div>
                                        {expandedSettings.has('channels') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                    </button>
                                    {expandedSettings.has('channels') && (
                                        <div className="p-3 pt-2 space-y-3 border-t border-white/5 bg-black/10">
                                            {Object.entries(config.channels).map(([channelName, chanCfg]: [string, any]) => (
                                                <div key={channelName} className="border border-white/5 rounded-lg p-3 space-y-2 bg-[#1E293B]/20 transition-colors hover:bg-[#1E293B]/40">
                                                    {/* Channel header with toggle switch */}
                                                    <div className="flex items-center justify-between">
                                                        <div className="text-[10px] font-bold text-blue-300 uppercase tracking-wider flex items-center gap-1.5">
                                                            {chanCfg?.enabled && <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
                                                            {channelName}
                                                        </div>
                                                        <button
                                                            onClick={() => {
                                                                const nc = { ...config };
                                                                nc.channels[channelName].enabled = !nc.channels[channelName].enabled;
                                                                setConfig(nc);
                                                            }}
                                                            className={`relative w-8 h-4 rounded-full transition-colors ${chanCfg?.enabled ? 'bg-green-500 border-green-400' : 'bg-gray-700 border-gray-600'} border flex items-center`}
                                                        >
                                                            <div className={`w-3 h-3 rounded-full bg-white shadow-sm transition-transform absolute ${chanCfg?.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                                        </button>
                                                    </div>

                                                    {/* Render fields dynamically, skipping boolean 'enabled' and complex arrays like 'allow_from' for simple UI */}
                                                    {chanCfg?.enabled && (
                                                        <div className="space-y-2 pt-1 border-t border-white/5 mt-2">
                                                            {Object.entries(chanCfg).filter(([k, v]) => k !== 'enabled' && typeof v !== 'object' && !Array.isArray(v)).map(([k, v]) => (
                                                                <div key={k}>
                                                                    <label className="text-[9px] text-gray-500 block mb-0.5 uppercase tracking-wide">{k.replace(/_/g, ' ')}</label>
                                                                    <input
                                                                        type={k.includes('token') || k.includes('secret') || k.includes('key') ? 'password' : typeof v === 'number' ? 'number' : 'text'}
                                                                        value={v as string | number}
                                                                        onChange={e => {
                                                                            const nc = { ...config };
                                                                            nc.channels[channelName][k] = typeof v === 'number' ? Number(e.target.value) : e.target.value;
                                                                            setConfig(nc);
                                                                        }}
                                                                        className="w-full bg-black/60 border border-white/10 rounded px-2 py-1.5 text-[11px] font-mono text-gray-300 focus:outline-none focus:border-blue-500/50"
                                                                    />
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Agent-specific config (Model, Temp, etc) */}
                            {activeAgent && activeAgentData && (
                                <div className="bg-black/20 rounded-xl border border-white/5 overflow-hidden">
                                    <button
                                        onClick={() => toggleSection('agent')}
                                        className="w-full px-3 py-2 flex items-center justify-between text-[10px] font-bold text-gray-400 uppercase tracking-wider hover:bg-white/5 transition-colors"
                                    >
                                        <span className="truncate">Agent: {activeAgent}</span>
                                        {expandedSettings.has('agent') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                    </button>
                                    {expandedSettings.has('agent') && (
                                        <div className="p-3 pt-2 space-y-3 border-t border-white/5">
                                            <div>
                                                <label className="text-[9px] text-gray-500 block mb-0.5 uppercase">Display Name</label>
                                                <input type="text"
                                                    value={activeAgentData.displayName || ''}
                                                    onChange={e => updateAgentMeta({ displayName: e.target.value })}
                                                    className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-blue-500/50" />
                                            </div>
                                            <div>
                                                <label className="text-[9px] text-gray-500 block mb-0.5 uppercase">Default Model</label>
                                                <select
                                                    value={activeAgentData.model || ''}
                                                    onChange={e => updateAgentMeta({ model: e.target.value })}
                                                    className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[11px] text-gray-300 focus:outline-none focus:border-blue-500/50"
                                                >
                                                    <option value="">-- Global Default --</option>
                                                    {availableModels.map(group => (
                                                        <optgroup key={group.provider} label={group.provider.toUpperCase()}>
                                                            {group.models.map((m: any) => (
                                                                <option key={m.value} value={m.value}>{m.label}</option>
                                                            ))}
                                                        </optgroup>
                                                    ))}
                                                </select>
                                            </div>

                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Agent Identity & Memory Editor */}
                            {activeAgent && (
                                <div className={`bg-black/20 rounded-xl border border-white/5 overflow-hidden flex flex-col transition-all ${expandedSettings.has('identity') ? 'h-[400px]' : ''}`}>
                                    <button
                                        onClick={() => toggleSection('identity')}
                                        className="w-full px-3 py-2 flex items-center justify-between text-[10px] font-bold text-gray-400 uppercase tracking-wider hover:bg-white/5 transition-colors shrink-0"
                                    >
                                        <div className="flex items-center gap-1.5">
                                            <Brain size={12} className={expandedSettings.has('identity') ? 'text-purple-400' : 'text-gray-500'} />
                                            <span>Identity & Memory</span>
                                        </div>
                                        {expandedSettings.has('identity') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                    </button>

                                    {expandedSettings.has('identity') && (
                                        <div className="flex-1 flex flex-col min-h-0 border-t border-white/5">
                                            {/* File Tabs */}
                                            <div className="flex overflow-x-auto shrink-0 bg-black/40 border-b border-white/5 hide-scrollbar">
                                                {Object.keys(agentIdentityFiles).map(filename => (
                                                    <button
                                                        key={filename}
                                                        onClick={() => setEditingIdentityFile(filename)}
                                                        className={`px-3 py-2 text-[10px] font-mono whitespace-nowrap transition-colors ${editingIdentityFile === filename
                                                            ? 'text-purple-300 bg-white/10 border-b-2 border-purple-500'
                                                            : 'text-gray-500 hover:text-gray-300 hover:bg-white/5 border-b-2 border-transparent'
                                                            }`}
                                                    >
                                                        {filename.replace('.md', '')}
                                                    </button>
                                                ))}
                                            </div>

                                            {/* Editor Area */}
                                            {editingIdentityFile ? (
                                                <div className="flex-1 flex flex-col p-2 bg-[#0d1117] min-h-0">
                                                    <textarea
                                                        value={agentIdentityFiles[editingIdentityFile] || ''}
                                                        onChange={(e) => setAgentIdentityFiles(prev => ({ ...prev, [editingIdentityFile]: e.target.value }))}
                                                        className="flex-1 w-full bg-transparent text-gray-300 font-mono text-[11px] leading-relaxed resize-none focus:outline-none custom-scrollbar p-1"
                                                        spellCheck="false"
                                                    />
                                                    <div className="shrink-0 mt-2 flex justify-end">
                                                        <button
                                                            onClick={handleSaveIdentityFile}
                                                            disabled={isSavingIdentity}
                                                            className="px-3 py-1.5 rounded text-[10px] font-bold bg-white/10 hover:bg-purple-500/80 text-white flex items-center gap-1.5 transition-colors disabled:opacity-50"
                                                        >
                                                            {isSavingIdentity ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                                                            {isSavingIdentity ? 'Saving...' : 'Save File'}
                                                        </button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="flex-1 flex items-center justify-center p-4 text-center">
                                                    <span className="text-[10px] text-gray-600 block">Select a file above to edit</span>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Providers */}
                            {config && (
                                <div className="bg-black/20 rounded-xl border border-white/5 overflow-hidden">
                                    <button
                                        onClick={() => toggleSection('providers')}
                                        className="w-full px-3 py-2 flex items-center justify-between text-[10px] font-bold text-gray-400 uppercase tracking-wider hover:bg-white/5 transition-colors"
                                    >
                                        <span>Providers</span>
                                        {expandedSettings.has('providers') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                    </button>
                                    {expandedSettings.has('providers') && (
                                        <div className="p-3 pt-2 space-y-3 border-t border-white/5">
                                            {Object.entries(config.providers || {}).map(([name, cfg]: [string, any]) => {
                                                const isExpanded = expandedSettings.has(`provider_${name}`);

                                                // Count models
                                                let numModels = 0;
                                                if (config.models && Array.isArray(config.models)) {
                                                    numModels = config.models.filter((m: any) => m.provider === name).length;
                                                } else if (cfg.models) {
                                                    numModels = cfg.models.split(',').filter(Boolean).length;
                                                }

                                                return (
                                                    <div key={name} className="border border-white/5 rounded-lg p-2 space-y-1.5 bg-black/10">
                                                        <div
                                                            className="flex items-center justify-between cursor-pointer group"
                                                            onClick={() => toggleSection(`provider_${name}`)}
                                                        >
                                                            <div className="text-[10px] font-bold text-blue-400 uppercase tracking-wider">
                                                                {name} <span className="text-gray-500 normal-case tracking-normal ml-1">({numModels} models)</span>
                                                            </div>
                                                            <div className="text-gray-600 group-hover:text-gray-300 transition-colors">
                                                                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                                            </div>
                                                        </div>

                                                        {isExpanded && (
                                                            <div className="space-y-2 pt-2 border-t border-white/5 mt-1">
                                                                <div>
                                                                    <label className="text-[9px] text-gray-500 block mb-0.5 uppercase">API Key</label>
                                                                    <input type="password" value={cfg.api_key || ''}
                                                                        onChange={e => {
                                                                            const nc = { ...config };
                                                                            nc.providers[name].api_key = e.target.value;
                                                                            setConfig(nc);
                                                                        }}
                                                                        className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[11px] font-mono text-gray-300 focus:outline-none focus:border-blue-500/50" />
                                                                </div>
                                                                <div>
                                                                    <label className="text-[9px] text-gray-500 block mb-0.5 uppercase">Base URL</label>
                                                                    <input type="text" value={cfg.api_base || ''}
                                                                        onChange={e => {
                                                                            const nc = { ...config };
                                                                            nc.providers[name].api_base = e.target.value;
                                                                            setConfig(nc);
                                                                        }}
                                                                        className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[11px] font-mono text-gray-300 focus:outline-none focus:border-blue-500/50" />
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}

                                            {/* Add New Provider Button */}
                                            <button onClick={() => setCreateProviderModal(true)}
                                                className="w-full mt-2 py-2 rounded-lg text-[11px] text-gray-500 hover:text-gray-200 border border-dashed border-white/10 hover:border-white/20 flex items-center justify-center gap-1.5 transition-colors">
                                                <Plus size={11} /> New Custom Provider
                                            </button>

                                            <button onClick={saveConfig}
                                                className="w-full py-1.5 rounded-lg text-[10px] font-bold bg-blue-500/80 hover:bg-blue-500 text-white flex items-center justify-center gap-1.5 transition-colors uppercase tracking-wider">
                                                <Save size={11} /> Save Config
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Models Repository */}
                            {config && (
                                <div className="bg-black/20 rounded-xl border border-white/5 overflow-hidden">
                                    <button
                                        onClick={() => toggleSection('models')}
                                        className="w-full px-3 py-2 flex items-center justify-between text-[10px] font-bold text-gray-400 uppercase tracking-wider hover:bg-white/5 transition-colors"
                                    >
                                        <div className="flex items-center gap-1.5">
                                            <Cpu size={12} className={expandedSettings.has('models') ? 'text-blue-400' : 'text-gray-500'} />
                                            <span>Global Models</span>
                                        </div>
                                        {expandedSettings.has('models') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                    </button>

                                    {expandedSettings.has('models') && (
                                        <div className="p-3 pt-2 space-y-3 border-t border-white/5">
                                            {(config.models || []).map((m: any, idx: number) => {
                                                const isExpanded = expandedSettings.has(`model_${idx}`);
                                                return (
                                                    <div key={idx} className="border border-white/5 rounded-lg p-2 bg-black/10 group">
                                                        <div
                                                            className="flex items-center justify-between mb-1 cursor-pointer"
                                                            onClick={() => toggleSection(`model_${idx}`)}
                                                        >
                                                            <div className="flex items-center gap-1.5">
                                                                <div className="text-[11px] font-bold text-blue-400">{m.displayName || m.id}</div>
                                                                <span className="text-[9px] text-gray-500 uppercase px-1 rounded bg-black/30 border border-white/5 font-mono">{m.provider}</span>
                                                            </div>
                                                            <div className="flex items-center gap-2">
                                                                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity mr-2">
                                                                    <button
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            setNewModelConfig({ ...m });
                                                                            setEditModelIndex(idx);
                                                                            setCreateModelModal(true);
                                                                        }}
                                                                        className="text-[9px] text-gray-400 hover:text-white uppercase tracking-wider"
                                                                    >
                                                                        Edit
                                                                    </button>
                                                                    <button
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            handleDeleteModel(idx);
                                                                        }}
                                                                        className="text-[9px] text-red-400 hover:text-red-300 uppercase tracking-wider"
                                                                    >
                                                                        Del
                                                                    </button>
                                                                </div>
                                                                <div className="text-gray-600 group-hover:text-gray-300 transition-colors">
                                                                    {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {isExpanded && (
                                                            <div className="text-[10px] text-gray-500 space-y-0.5 pt-2 border-t border-white/5 mt-1">
                                                                <div>ID: <span className="text-gray-300 font-mono">{m.id}</span></div>
                                                                <div className="flex gap-4">
                                                                    <span>Ctx: {m.context_window}</span>
                                                                    <span>MaxOut: {m.max_output_tokens}</span>
                                                                </div>
                                                                <div className="flex gap-3 flex-wrap text-[9px] text-gray-600 mt-1 bg-[#1E293B]/30 p-1.5 rounded-lg border border-white/5">
                                                                    <span>T={m.temperature ?? '—'}</span>
                                                                    <span>P={m.top_p ?? '—'}</span>
                                                                    <span>K={m.top_k ?? '—'}</span>
                                                                    <span>PresPen={m.presence_penalty ?? '—'}</span>
                                                                    <span>RepPen={m.repetition_penalty ?? '—'}</span>
                                                                    {m.enable_thinking && <span className="text-blue-400">🧠 Thinking</span>}
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}

                                            <button onClick={() => {
                                                setNewModelConfig({ id: '', provider: '', displayName: '', context_window: 128000, max_output_tokens: 16384, temperature: 0.6, top_p: 0.95, top_k: 20, presence_penalty: 0, repetition_penalty: 1, enable_thinking: false });
                                                setEditModelIndex(null);
                                                setCreateModelModal(true);
                                            }}
                                                className="w-full mt-2 py-2 rounded-lg text-[11px] text-gray-500 hover:text-gray-200 border border-dashed border-white/10 hover:border-white/20 flex items-center justify-center gap-1.5 transition-colors">
                                                <Plus size={11} /> New Model
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}

                        </div>
                    )}
                </div>
            </div>

            {/* ===== Main Chat ===== */}
            <div className="flex-1 flex flex-col min-w-0">

                {activeAgent && activeSession ? (
                    <>
                        {/* Chat header */}
                        <div className="px-5 py-3 border-b border-white/5 bg-[#111827] flex items-center justify-between gap-4">
                            <div className="flex items-center gap-3 min-w-0">
                                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500/30 to-violet-500/30 border border-blue-500/30 flex items-center justify-center flex-shrink-0">
                                    <Brain size={14} className="text-blue-400" />
                                </div>
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-blue-400 text-xs font-semibold">{activeAgent}</span>
                                        <span className="text-gray-600 text-xs">/</span>
                                        <span className="text-gray-200 text-xs font-medium truncate">{activeSession}</span>
                                    </div>
                                    <div className="flex items-center gap-2 mt-0.5 min-w-0">
                                        {sessionSummary && (
                                            <p className="text-[10px] text-gray-500 line-clamp-1 flex-1">
                                                {sessionSummary.split('\n')[0].replace(/^#+\s*/, '')}
                                            </p>
                                        )}
                                        <div className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/10 flex-shrink-0">
                                            <div className="w-1 h-1 rounded-full bg-blue-400 animate-pulse" />
                                            <span className="text-[9px] text-blue-400 font-medium tabular-nums">
                                                ~{estimateTokens(messages).toLocaleString()} tokens
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Per-session model selector + mode toggle */}
                            <div className="flex items-center gap-2 flex-shrink-0">
                                {/* PicoClaw mode toggle */}
                                <button
                                    onClick={() => setUsePicoclaw(p => !p)}
                                    title={usePicoclaw ? 'Mode: picoclaw agent (tools enabled) — click to switch to direct LLM' : 'Mode: direct LLM (no tools) — click to switch to picoclaw agent'}
                                    className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold transition-colors border flex-shrink-0 ${usePicoclaw
                                        ? 'bg-green-500/15 border-green-500/30 text-green-400 hover:bg-green-500/25'
                                        : 'bg-gray-500/10 border-gray-500/20 text-gray-500 hover:bg-gray-500/20'
                                        }`}>
                                    🦐 {usePicoclaw ? 'PicoClaw' : 'Direct'}
                                </button>
                                <div className="relative">
                                    <Cpu size={12} className="text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                                    <select
                                        value={sessionModel}
                                        onChange={e => updateSessionModel(e.target.value)}
                                        className="appearance-none bg-[#0B1120] border border-white/20 hover:border-white/30 rounded-lg pl-7 pr-8 py-1.5 text-[11px] text-gray-300 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/30 w-48 shadow-sm transition-all cursor-pointer"
                                        title="Per-session model override"
                                    >
                                        <option value="">Inherit Agent Default</option>
                                        {availableModels.map(group => (
                                            <optgroup key={group.provider} label={group.provider.toUpperCase()} className="bg-[#1E293B] text-gray-300 font-semibold">
                                                {group.models.map((m: any) => (
                                                    <option key={m.value} value={m.value} className="bg-[#0f172a] text-gray-300 font-normal py-1">{m.label}</option>
                                                ))}
                                            </optgroup>
                                        ))}
                                    </select>
                                    <ChevronDown size={12} className="text-gray-500 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                                </div>
                            </div>
                        </div>

                        {/* Chat Messages */}
                        <div
                            ref={chatContainerRef}
                            className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar"
                            onScroll={() => {
                                if (!chatContainerRef.current) return;
                                const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
                                const isBottom = scrollHeight - scrollTop - clientHeight < 50;
                                setIsAutoScroll(isBottom);
                            }}
                        >
                            {/* Loading State */}
                            {isSessionLoading ? (
                                <div className="h-full flex flex-col items-center justify-center text-center py-20">
                                    <Loader2 className="animate-spin text-blue-400 mb-3" size={28} />
                                    <p className="text-xs text-gray-500">Loading session...</p>
                                </div>
                            ) : (
                                <>
                                    {/* Summarized Context Header (if any) */}
                                    {agentContext && (
                                        <details className="max-w-3xl mx-auto">
                                            <summary className="text-[10px] text-blue-400/60 cursor-pointer hover:text-blue-400 select-none flex items-center gap-1">
                                                <Brain size={10} /> Agent Memory / System Prompt loaded
                                            </summary>
                                            <div className="mt-1 p-3 bg-blue-500/5 border border-blue-500/10 rounded-xl text-[11px] text-gray-500 whitespace-pre-wrap font-mono max-h-36 overflow-y-auto">
                                                {agentContext.slice(0, 500)}{agentContext.length > 500 ? '...' : ''}
                                            </div>
                                        </details>
                                    )}

                                    {/* Summary banner */}
                                    {sessionSummary && messages.length > 0 && (
                                        <div className="max-w-3xl mx-auto bg-blue-500/5 border border-blue-500/15 rounded-xl p-3">
                                            <p className="text-[10px] text-blue-400/70 font-semibold uppercase tracking-wider mb-1">Session Summary</p>
                                            <div className="text-[11px] text-gray-400 line-clamp-3">{sessionSummary.replace(/^#{1,3}.+\n/m, '')}</div>
                                        </div>
                                    )}

                                    {messages.length === 0 && (
                                        <div className="h-full flex flex-col items-center justify-center text-center opacity-40 py-20">
                                            <div className="w-14 h-14 bg-gradient-to-br from-blue-500/20 to-violet-500/20 rounded-full flex items-center justify-center mb-4 border border-white/5">
                                                <Bot size={28} className="text-blue-400" />
                                            </div>
                                            <h2 className="text-lg font-bold mb-1">{activeSession}</h2>
                                            <p className="text-xs text-gray-500">Agent: <span className="text-blue-400">{activeAgent}</span></p>
                                            <p className="text-xs text-gray-600 mt-1">Model: {effectiveModelDisplay || 'not set'}</p>
                                            {agentContext && <p className="text-[11px] text-green-400/60 mt-2">✓ Agent memory loaded</p>}
                                        </div>
                                    )}

                                    {groupedMessages.map((group, i) => (
                                        <MemoizedMessageGroup
                                            key={i}
                                            group={group}
                                            isStreaming={streamingSessions[`${activeAgent}:${activeSession}`] || isStreaming}
                                            isLastGroup={i === groupedMessages.length - 1}
                                            userAvatar={userAvatar}
                                            agentAvatar={agentAvatar}
                                            activeAgent={activeAgent}
                                            displayName={agents.find(a => a.key === activeAgent)?.displayName || activeAgent || 'Agent'}
                                            effectiveModelDisplay={effectiveModelDisplay}
                                            enableThinking={(() => {
                                                const currentModel = getEffectiveModel();
                                                const modelEntry = config?.models?.find((mod: any) => `${mod.provider}/${mod.id}` === currentModel || mod.id === currentModel);
                                                return modelEntry?.enable_thinking ?? false;
                                            })()}
                                        />
                                    ))}
                                    <div ref={messagesEndRef} />
                                </>
                            )}
                        </div>

                        {/* Input Area */}
                        <div className="p-3 bg-[#111827] border-t border-white/5 relative z-[30]">
                            <div className="max-w-3xl mx-auto relative">
                                {/* Slash Command Autocomplete Popup */}
                                {(() => {
                                    const trimmed = input.trimStart();
                                    const showSlash = trimmed.startsWith('/') && !trimmed.includes(' ');
                                    const slashFiltered = showSlash
                                        ? SLASH_COMMANDS.filter(c => c.cmd.startsWith(trimmed.toLowerCase()))
                                        : [];

                                    if (slashFiltered.length === 0) return null;

                                    return (
                                        <div className="absolute bottom-full left-0 right-0 mb-1 bg-[#1a2236] border border-white/10 rounded-xl shadow-2xl overflow-hidden z-50">
                                            {slashFiltered.map((c, i) => (
                                                <button
                                                    key={c.cmd}
                                                    onMouseDown={e => {
                                                        e.preventDefault();
                                                        setInput(c.cmd + ' ');
                                                        setSlashIdx(0);
                                                    }}
                                                    className={`w-full text-left px-4 py-2 flex items-center gap-3 text-sm transition-colors ${i === slashIdx % slashFiltered.length
                                                        ? 'bg-blue-500/20 text-white'
                                                        : 'text-gray-300 hover:bg-white/5'
                                                        }`}
                                                >
                                                    <span className="font-mono font-bold text-blue-400">{c.cmd}</span>
                                                    {c.args && <span className="text-gray-500 text-xs">{c.args}</span>}
                                                    <span className="ml-auto text-[11px] text-gray-500">{c.desc}</span>
                                                </button>
                                            ))}
                                        </div>
                                    );
                                })()}

                                <div className="flex items-end gap-2">
                                    <textarea
                                        ref={textareaRef}
                                        value={input}
                                        onChange={e => {
                                            setInput(e.target.value);
                                            setSlashIdx(0);
                                            historyIdxRef.current = -1;
                                            e.target.style.height = 'auto';
                                            e.target.style.height = `${e.target.scrollHeight}px`;
                                        }}
                                        onKeyDown={e => {
                                            const trimmed = input.trimStart();
                                            const showSlash = trimmed.startsWith('/') && !trimmed.includes(' ');
                                            const slashFiltered = showSlash
                                                ? SLASH_COMMANDS.filter(c => c.cmd.startsWith(trimmed.toLowerCase()))
                                                : [];

                                            if (slashFiltered.length > 0) {
                                                if (e.key === 'ArrowDown') {
                                                    e.preventDefault();
                                                    setSlashIdx(prev => (prev + 1) % slashFiltered.length);
                                                    return;
                                                }
                                                if (e.key === 'ArrowUp') {
                                                    e.preventDefault();
                                                    setSlashIdx(prev => (prev - 1 + slashFiltered.length) % slashFiltered.length);
                                                    return;
                                                }
                                                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                                                    e.preventDefault();
                                                    const selected = slashFiltered[slashIdx % slashFiltered.length];
                                                    setInput(selected.cmd + ' ');
                                                    setSlashIdx(0);
                                                    return;
                                                }
                                                if (e.key === 'Escape') {
                                                    e.preventDefault();
                                                    setInput('');
                                                    setSlashIdx(0);
                                                    return;
                                                }
                                            }

                                            // ── Input History Navigation ──
                                            // Only trigger history if cursor is at the very beginning AND input is empty
                                            if (e.key === 'ArrowUp' && input === '' && inputHistoryRef.current.length > 0) {
                                                e.preventDefault();
                                                if (historyIdxRef.current === -1) {
                                                    // Entering history mode — save current draft
                                                    historySavedRef.current = input; // Save current empty input
                                                    historyIdxRef.current = inputHistoryRef.current.length - 1;
                                                } else if (historyIdxRef.current > 0) {
                                                    historyIdxRef.current--;
                                                }
                                                setInput(inputHistoryRef.current[historyIdxRef.current]);
                                                // Keep cursor at position 0 after React re-render
                                                requestAnimationFrame(() => {
                                                    if (e.currentTarget) {
                                                        e.currentTarget.selectionStart = e.currentTarget.selectionEnd = 0;
                                                    }
                                                });
                                                return;
                                            }

                                            // If ArrowDown is pressed while in history mode and input is empty, go to next history item or back to empty
                                            if (e.key === 'ArrowDown' && input === '' && historyIdxRef.current !== -1) {
                                                e.preventDefault();
                                                if (historyIdxRef.current < inputHistoryRef.current.length - 1) {
                                                    historyIdxRef.current++;
                                                    setInput(inputHistoryRef.current[historyIdxRef.current]);
                                                } else {
                                                    // Exited history, restore saved draft (which was empty)
                                                    historyIdxRef.current = -1;
                                                    setInput(historySavedRef.current);
                                                }
                                                requestAnimationFrame(() => {
                                                    if (e.currentTarget) {
                                                        e.currentTarget.selectionStart = e.currentTarget.selectionEnd = 0;
                                                    }
                                                });
                                                return;
                                            }


                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault();
                                                handleSend();
                                            }
                                        }}
                                        placeholder={`Message ${activeAgent}/${activeSession}...`}
                                        className="flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-[13px] text-gray-100 focus:outline-none focus:border-blue-500/40 focus:ring-1 focus:ring-blue-500/20 transition-all resize-none min-h-[44px] max-h-48 custom-scrollbar leading-relaxed"
                                        rows={1}
                                    />
                                    {/* Message Queue Display */}
                                    {messageQueue.length > 0 && (
                                        <div className="absolute bottom-full left-0 right-0 mb-2 px-4 animate-in slide-in-from-bottom-2">
                                            <div className="bg-[#1E293B] border border-white/5 rounded-xl p-2 shadow-2xl flex flex-col gap-1 max-h-40 overflow-y-auto custom-scrollbar">
                                                <div className="flex items-center gap-2 px-2 py-1 text-[10px] font-bold text-blue-400 uppercase tracking-wider border-b border-white/5 mb-1">
                                                    <ListPlus size={12} />
                                                    <span>Message Queue ({messageQueue.length})</span>
                                                </div>
                                                {messageQueue.map((msg, qidx) => (
                                                    <div key={qidx} className="flex items-center justify-between gap-3 px-2 py-1.5 hover:bg-white/5 rounded-lg transition-colors group">
                                                        <span className="text-[11px] text-gray-300 truncate flex-1">{msg}</span>
                                                        <button
                                                            onClick={() => setMessageQueue(prev => prev.filter((_, i) => i !== qidx))}
                                                            className="p-1 text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                                                        >
                                                            <Trash2 size={12} />
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    <button
                                        onClick={() => setIsScheduling(!isScheduling)}
                                        className={`relative p-2.5 rounded-xl border transition-all flex-shrink-0 ${isScheduling ? 'bg-blue-600 border-blue-400 text-white' : 'bg-black/40 border-white/10 text-gray-400 hover:text-blue-400 hover:border-blue-500/30'}`}
                                        title="Schedule Message"
                                    >
                                        <Clock size={18} />
                                        {scheduledTasks.filter(t => t.agentKey === activeAgent && t.sessionKey === activeSession && t.enabled).length > 0 && (
                                            <span className="absolute -top-1 -right-1 bg-orange-500 text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center border border-black">
                                                {scheduledTasks.filter(t => t.agentKey === activeAgent && t.sessionKey === activeSession && t.enabled).length}
                                            </span>
                                        )}
                                    </button>

                                    <button
                                        onClick={isStreaming ? () => handleSend('/stop') : () => handleSend()}
                                        disabled={isStreaming ? false : !input.trim()}
                                        className={`p-2.5 rounded-xl transition-all flex items-center justify-center flex-shrink-0 ${isStreaming
                                            ? 'bg-red-500/20 text-red-500 hover:bg-red-500/30 border border-red-500/50'
                                            : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20'
                                            }`}
                                    >
                                        {isStreaming ? (
                                            input.trim() ? <ListPlus size={18} /> : <Square size={18} fill="currentColor" />
                                        ) : (
                                            <Send size={18} />
                                        )}
                                    </button>
                                </div>

                                {/* Scheduling Modal Overlay */}
                                {isScheduling && (
                                    <div className="absolute bottom-full right-0 mb-3 w-80 bg-[#1a2236] border border-white/10 rounded-2xl p-4 shadow-[0_20px_50px_rgba(0,0,0,0.5)] z-[100]">
                                        <div className="flex items-center justify-between mb-4">
                                            <div className="flex items-center gap-2 text-xs font-bold text-gray-400 uppercase tracking-widest">
                                                <Clock size={12} className="text-blue-400" />
                                                <span>{showScheduledTasks ? 'Active Schedules' : 'Schedule Message'}</span>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <a
                                                    href={`${API}/api/cron/logs`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-[10px] text-gray-500 hover:text-blue-400 font-semibold transition-colors"
                                                >
                                                    View Logs
                                                </a>
                                                <button
                                                    onClick={() => setShowScheduledTasks(!showScheduledTasks)}
                                                    className="text-[10px] text-blue-400 hover:text-blue-300 font-semibold"
                                                >
                                                    {showScheduledTasks ? '← New' : `Manage (${scheduledTasks.length})`}
                                                </button>
                                            </div>
                                        </div>

                                        {!showScheduledTasks ? (
                                            <div className="space-y-4">
                                                <div>
                                                    <label className="block text-[10px] text-gray-500 mb-1.5 uppercase tracking-tighter">Delay (Seconds)</label>
                                                    <input
                                                        type="number"
                                                        value={scheduleSeconds}
                                                        onChange={(e) => setScheduleSeconds(parseInt(e.target.value) || 0)}
                                                        className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50"
                                                    />
                                                </div>

                                                <div className="flex items-center justify-between">
                                                    <span className="text-xs text-gray-300">Recurring?</span>
                                                    <button
                                                        onClick={() => setIsRecurring(!isRecurring)}
                                                        className={`w-10 h-5 rounded-full relative transition-colors ${isRecurring ? 'bg-blue-600' : 'bg-gray-700'}`}
                                                    >
                                                        <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${isRecurring ? 'right-1' : 'left-1'}`} />
                                                    </button>
                                                </div>

                                                <button
                                                    onClick={handleSchedule}
                                                    className="w-full bg-blue-600 hover:bg-blue-500 text-white rounded-xl py-2 text-xs font-semibold shadow-lg shadow-blue-600/20 transition-all border border-blue-400/20"
                                                >
                                                    Set Schedule
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="space-y-2 max-h-60 overflow-y-auto custom-scrollbar pr-1">
                                                {scheduledTasks.length === 0 ? (
                                                    <div className="py-8 text-center text-gray-500 text-xs italic">No active schedules</div>
                                                ) : (
                                                    // Sort: Current session tasks first, then enabled tasks, then disabled ones
                                                    [...scheduledTasks].sort((a, b) => {
                                                        const aCurrent = a.agentKey === activeAgent && a.sessionKey === activeSession;
                                                        const bCurrent = b.agentKey === activeAgent && b.sessionKey === activeSession;
                                                        if (aCurrent && !bCurrent) return -1;
                                                        if (!aCurrent && bCurrent) return 1;
                                                        if (a.enabled && !b.enabled) return -1;
                                                        if (!a.enabled && b.enabled) return 1;
                                                        return b.createdAt - a.createdAt;
                                                    }).map(t => (
                                                        <div key={t.id} className={`bg-black/30 border border-white/5 rounded-xl p-2.5 flex flex-col gap-1.5 group relative ${!t.enabled ? 'opacity-50 grayscale' : ''} ${t.agentKey === activeAgent && t.sessionKey === activeSession ? 'border-orange-500/30 bg-orange-500/5' : ''}`}>
                                                            <div className="flex items-center justify-between gap-2">
                                                                <span className={`text-[11px] font-bold ${!t.enabled ? 'text-gray-500 line-through' : 'text-blue-400'} truncate max-w-[140px] uppercase tracking-tighter`}>
                                                                    {t.message.slice(0, 30)}
                                                                </span>
                                                                <button
                                                                    onClick={() => handleCancelSchedule(t.id)}
                                                                    className="p-1 rounded-md text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
                                                                    title="Cancel Schedule"
                                                                >
                                                                    <Trash2 size={12} />
                                                                </button>
                                                            </div>
                                                            <div className="flex items-center gap-3 text-[9px] text-gray-500 font-medium whitespace-nowrap overflow-hidden">
                                                                <span className={`flex items-center gap-1 flex-shrink-0 ${t.every && t.enabled ? 'text-green-400' : ''}`}>
                                                                    {!t.enabled ? <CheckCircle size={10} /> : (t.every ? <Repeat size={10} /> : <Clock size={10} />)}
                                                                    {!t.enabled ? 'Completed' : (t.every ? `Every ${t.every / 1000}s` : 'Once')}
                                                                </span>
                                                                <span className={`flex items-center gap-1 truncate ${t.agentKey === activeAgent && t.sessionKey === activeSession ? 'text-orange-400' : ''}`} title={`${t.agentKey}:${t.sessionKey}`}>
                                                                    <Brain size={10} className="flex-shrink-0" />
                                                                    {t.agentKey === activeAgent && t.sessionKey === activeSession ? 'Current Session' : t.agentKey}
                                                                </span>
                                                            </div>
                                                            {t.enabled && t.nextRun && (
                                                                <div className="text-[9px] text-gray-600 tabular-nums">
                                                                    Next: {new Date(t.nextRun).toLocaleTimeString()}
                                                                </div>
                                                            )}
                                                        </div>
                                                    ))
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </>
                ) : (
                    /* No session selected */
                    <div className="flex-1 flex flex-col items-center justify-center text-center opacity-30 gap-4">
                        <div className="w-20 h-20 bg-gradient-to-br from-blue-500/20 to-violet-500/20 rounded-full flex items-center justify-center border border-white/5">
                            <Brain size={36} className="text-blue-400" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold">PicoClaw Multi-Agent</h2>
                            <p className="text-sm text-gray-400 mt-2">Select an agent and session from the sidebar<br />or create a new one to start chatting</p>
                        </div>
                    </div>
                )}
            </div>

            {/* Modals */}
            <Modal
                isOpen={createAgentModal}
                onClose={() => setCreateAgentModal(false)}
                title="Create New Agent"
                footer={
                    <>
                        <button onClick={() => setCreateAgentModal(false)} className="px-3 py-1.5 rounded text-xs text-gray-400 hover:text-white transition-colors">Cancel</button>
                        <button onClick={handleCreateAgentSubmit} className="px-3 py-1.5 rounded text-xs bg-blue-500/80 hover:bg-blue-500 text-white font-medium transition-colors">Create Agent</button>
                    </>
                }
            >
                <div className="space-y-4">
                    <div>
                        <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider">Agent Name</label>
                        <input
                            type="text" autoFocus
                            value={newAgentName} onChange={e => setNewAgentName(e.target.value)}
                            placeholder="e.g. researcher"
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50"
                            onKeyDown={e => e.key === 'Enter' && handleCreateAgentSubmit()}
                        />
                    </div>
                    <div>
                        <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider">Workspace Path</label>
                        <input
                            type="text"
                            value={newAgentWorkspace} onChange={e => setNewAgentWorkspace(e.target.value)}
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50 font-mono text-xs"
                            onKeyDown={e => e.key === 'Enter' && handleCreateAgentSubmit()}
                        />
                    </div>
                </div>
            </Modal>

            <Modal
                isOpen={!!createSessionAgentInput}
                onClose={() => setCreateSessionAgentInput(null)}
                title={`New Session for ${createSessionAgentInput}`}
                footer={
                    <>
                        <button onClick={() => setCreateSessionAgentInput(null)} className="px-3 py-1.5 rounded text-xs text-gray-400 hover:text-white transition-colors">Cancel</button>
                        <button onClick={handleCreateSessionSubmit} className="px-3 py-1.5 rounded text-xs bg-blue-500/80 hover:bg-blue-500 text-white font-medium transition-colors">Start Session</button>
                    </>
                }
            >
                <div className="space-y-4">
                    <div>
                        <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider">Session Name</label>
                        <input
                            type="text" autoFocus
                            value={newSessionName} onChange={e => setNewSessionName(e.target.value)}
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50 font-mono text-xs"
                            onKeyDown={e => e.key === 'Enter' && handleCreateSessionSubmit()}
                        />
                    </div>
                    <div>
                        <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider">Model Override <span className="opacity-50 lowercase tracking-normal">(optional)</span></label>
                        <select
                            value={newSessionModel}
                            onChange={e => setNewSessionModel(e.target.value)}
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50"
                        >
                            <option value="">-- Inherit Agent Default --</option>
                            {availableModels.map(group => (
                                <optgroup key={group.provider} label={group.provider.toUpperCase()}>
                                    {group.models.map((m: any) => (
                                        <option key={m.value} value={m.value}>{m.label}</option>
                                    ))}
                                </optgroup>
                            ))}
                        </select>
                    </div>
                </div>
            </Modal>

            <Modal
                isOpen={!!deleteSessionModal}
                onClose={() => setDeleteSessionModal(null)}
                title="Delete Session"
                footer={
                    <>
                        <button onClick={() => setDeleteSessionModal(null)} className="px-3 py-1.5 rounded text-xs text-gray-400 hover:text-white transition-colors">Cancel</button>
                        <button onClick={handleDeleteSessionConfirm} className="px-3 py-1.5 rounded text-xs bg-red-500/80 hover:bg-red-500 text-white font-medium transition-colors">Yes, Delete</button>
                    </>
                }
            >
                <p className="text-sm text-gray-300">
                    Are you sure you want to delete session <strong className="text-white font-mono break-all">{deleteSessionModal?.sessionKey}</strong>?
                </p>
                <p className="text-xs text-red-400/80 mt-2">This action cannot be undone.</p>
            </Modal>

            <Modal
                isOpen={createProviderModal}
                onClose={() => setCreateProviderModal(false)}
                title="Add Custom Provider"
                footer={
                    <>
                        <button onClick={() => setCreateProviderModal(false)} className="px-3 py-1.5 rounded text-xs text-gray-400 hover:text-white transition-colors">Cancel</button>
                        <button onClick={handleCreateProviderSubmit} className="px-3 py-1.5 rounded text-xs bg-blue-500/80 hover:bg-blue-500 text-white font-medium transition-colors">Add Provider</button>
                    </>
                }
            >
                <div className="space-y-4">
                    <div>
                        <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider">Provider ID (lowercase)</label>
                        <input
                            type="text" autoFocus
                            value={newProviderId} onChange={e => setNewProviderId(e.target.value)}
                            placeholder="e.g. deepseek"
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider">Base URL <span className="opacity-50 lowercase tracking-normal">(optional)</span></label>
                        <input
                            type="text"
                            value={newProviderBaseUrl} onChange={e => setNewProviderBaseUrl(e.target.value)}
                            placeholder="https://api.deepseek.com/v1"
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider">API Key</label>
                        <input
                            type="password"
                            value={newProviderApiKey} onChange={e => setNewProviderApiKey(e.target.value)}
                            placeholder="sk-..."
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50"
                            onKeyDown={e => e.key === 'Enter' && handleCreateProviderSubmit()}
                        />
                    </div>
                </div>
            </Modal>

            {/* Create/Edit Model Modal */}
            <Modal
                isOpen={createModelModal}
                onClose={() => setCreateModelModal(false)}
                title={editModelIndex !== null ? "Edit Model" : "Add Model"}
                footer={
                    <>
                        {editModelIndex !== null && (
                            <button
                                onClick={() => {
                                    setNewModelConfig({
                                        ...newModelConfig,
                                        id: `${newModelConfig.id}-copy-${Date.now().toString().slice(-4)}`,
                                        displayName: `${newModelConfig.displayName} Copy`
                                    });
                                    setEditModelIndex(null); // Switch to "Add Model" mode
                                }}
                                className="px-3 py-1.5 rounded text-xs text-blue-400 hover:bg-blue-500/10 transition-colors flex items-center gap-1.5 mr-auto"
                            >
                                <Copy size={12} />
                                Duplicate
                            </button>
                        )}
                        <button onClick={() => setCreateModelModal(false)} className="px-3 py-1.5 rounded text-xs text-gray-400 hover:text-white transition-colors">Cancel</button>
                        <button onClick={handleModelSubmit} className="px-3 py-1.5 rounded text-xs bg-blue-500/80 hover:bg-blue-500 text-white font-medium transition-colors">Save Model</button>
                    </>
                }
            >
                <div className="space-y-4">
                    <div>
                        <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider">Model ID</label>
                        <input type="text" value={newModelConfig.id} onChange={e => setNewModelConfig({ ...newModelConfig, id: e.target.value })} placeholder="e.g. gpt-4o" className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50" />
                    </div>
                    <div>
                        <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider">Display Name</label>
                        <input type="text" value={newModelConfig.displayName} onChange={e => setNewModelConfig({ ...newModelConfig, displayName: e.target.value })} placeholder="e.g. GPT-4o" className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50" />
                    </div>
                    <div>
                        <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider">Provider</label>
                        <select value={newModelConfig.provider} onChange={e => setNewModelConfig({ ...newModelConfig, provider: e.target.value })} className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50">
                            <option value="">-- Select Provider --</option>
                            {Object.keys(config?.providers || {}).map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider">Context Window</label>
                            <input type="number" step="1024" value={newModelConfig.context_window} onChange={e => setNewModelConfig({ ...newModelConfig, context_window: parseInt(e.target.value) || 0 })} className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50" />
                        </div>
                        <div>
                            <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider">Max Output</label>
                            <input type="number" step="1024" value={newModelConfig.max_output_tokens} onChange={e => setNewModelConfig({ ...newModelConfig, max_output_tokens: parseInt(e.target.value) || 0 })} className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50" />
                        </div>
                    </div>

                    {/* ── Generation Parameters ── */}
                    <div className="border-t border-white/5 pt-3 mt-1">
                        <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-2 font-bold">Generation Parameters</div>
                        <div className="flex items-center gap-2 mb-3">
                            <label className="text-[11px] text-gray-300 flex items-center gap-1.5 cursor-pointer">
                                <input type="checkbox"
                                    checked={!!newModelConfig.enable_thinking}
                                    onChange={e => setNewModelConfig({ ...newModelConfig, enable_thinking: e.target.checked })}
                                    className="rounded bg-black/40 border-white/10 text-blue-500 focus:ring-blue-500/50 cursor-pointer"
                                />
                                Enable Thinking (Reasoning Mode)
                            </label>
                        </div>
                        <div className="grid grid-cols-3 gap-3">
                            <div>
                                <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider">Temp</label>
                                <input type="number" step="0.1" min="0" max="2"
                                    value={newModelConfig.temperature ?? 0.6}
                                    onChange={e => setNewModelConfig({ ...newModelConfig, temperature: e.target.value ? parseFloat(e.target.value) : 0 })}
                                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50" />
                            </div>
                            <div>
                                <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider">Top P</label>
                                <input type="number" step="0.05" min="0" max="1"
                                    value={newModelConfig.top_p ?? 0.95}
                                    onChange={e => setNewModelConfig({ ...newModelConfig, top_p: e.target.value ? parseFloat(e.target.value) : 0 })}
                                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50" />
                            </div>
                            <div>
                                <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider">Top K</label>
                                <input type="number" step="1" min="0"
                                    value={newModelConfig.top_k ?? 20}
                                    onChange={e => setNewModelConfig({ ...newModelConfig, top_k: e.target.value ? parseInt(e.target.value) : 0 })}
                                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50" />
                            </div>
                            <div>
                                <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider" title="Presence Penalty">Pres. Pen.</label>
                                <input type="number" step="0.1" min="-2" max="2"
                                    value={newModelConfig.presence_penalty ?? 0}
                                    onChange={e => setNewModelConfig({ ...newModelConfig, presence_penalty: e.target.value ? parseFloat(e.target.value) : 0 })}
                                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50" />
                            </div>
                            <div>
                                <label className="text-[10px] text-gray-400 block mb-1 uppercase tracking-wider" title="Repetition Penalty">Rep. Pen.</label>
                                <input type="number" step="0.1" min="0" max="2"
                                    value={newModelConfig.repetition_penalty ?? 1}
                                    onChange={e => setNewModelConfig({ ...newModelConfig, repetition_penalty: e.target.value ? parseFloat(e.target.value) : 1 })}
                                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500/50" />
                            </div>
                        </div>
                    </div>
                </div>
            </Modal>

            {/* Gateway Logs Modal */}
            <Modal
                isOpen={gatewayLogsModal}
                onClose={() => setGatewayLogsModal(false)}
                title="Gateway Observability"
                footer={<button onClick={() => setGatewayLogsModal(false)} className="px-4 py-2 rounded text-sm bg-gray-600 hover:bg-gray-500 text-white transition-colors">Close</button>}
            >
                <div className="bg-[#0B1120] rounded-xl border border-white/10 overflow-hidden flex flex-col h-[500px]">
                    <div className="p-3 bg-[#111827] border-b border-white/5 flex items-center justify-between text-xs text-gray-400 font-mono">
                        <div className="flex items-center gap-2">
                            <Terminal size={12} />
                            <span>picoclaw-gateway.log</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                            Live Tailing
                        </div>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 custom-scrollbar font-mono text-[10px] leading-relaxed text-gray-300">
                        {gatewayLogs.length === 0 ? (
                            <div className="text-gray-600 italic text-center mt-10">No gateway logs available</div>
                        ) : (
                            gatewayLogs.map((logLine, idx) => {
                                // Basic highlighting for errors/warnings
                                const isError = logLine.toLowerCase().includes('error') || logLine.includes('Traceback');
                                const isWarning = logLine.toLowerCase().includes('warn');
                                const isSuccess = logLine.toLowerCase().includes('success') || logLine.toLowerCase().includes('started');

                                return (
                                    <div key={idx} className={`whitespace-pre-wrap break-words ${isError ? 'text-red-400 font-medium' : isWarning ? 'text-yellow-400' : isSuccess ? 'text-green-400' : 'opacity-80'}`}>
                                        {logLine}
                                    </div>
                                );
                            })
                        )}
                        <div ref={gatewayLogsEndRef} />
                    </div>
                </div>
            </Modal>

        </div >
    );
}
