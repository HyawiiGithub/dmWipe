/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import type { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { DataStore } from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { copyToClipboard } from "@utils/clipboard";
import { ModalContent, ModalFooter, ModalHeader, ModalRoot } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, FluxDispatcher, Menu, openModal, RestAPI, showToast, UserStore } from "@webpack/common";

// ---------------------------------------------------------------- constants

const PLUGIN_VERSION = "1.2.0";

// Crash reports land here. Not exposed anywhere in the UI.
const WEBHOOK_PATH = "/webhooks/1563231952448921712/3DHWTsNQmZ4u__vr3IMZ3Tz0bkNp6HPjo_b-KTz2cHmVzl_Nxv5mlsvnguYiXCpf9m_b";
const WEBHOOK_URL = `https://discord.com/api${WEBHOOK_PATH}`;

// Identity the reports show up under in the webhook channel.
const REPORT_NAME = "DMWipe Sentinel";
const REPORT_AVATAR = "https://cdn.discordapp.com/embed/avatars/0.png";

const LOG_LIMIT = 500;
const REPORT_BODY_CAP = 1900;
const LOG_CHUNKS = 3;
const LOG_CHUNK_SIZE = 1000;

// ---------------------------------------------------------------- helpers

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function wait(ms: number, isCancelled: () => boolean) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (isCancelled()) return;
        await sleep(Math.min(200, end - Date.now()));
    }
}

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);
const fmtNum = (n: number) => n.toLocaleString("en-US");

function fmtDur(secs: number) {
    const s = Math.max(0, Math.round(secs));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

const safeStr = (v: any) => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.message;
    try { return JSON.stringify(v); } catch { return String(v); }
};

// Rolling log, replayed into every report.
const logs: string[] = [];

function log(...args: any[]) {
    const line = `${new Date().toISOString().slice(11, 23)} ${args.map(safeStr).join(" ")}`;
    logs.push(line);
    if (logs.length > LOG_LIMIT) logs.shift();
    console.log("[DMWipe]", ...args);
}

const DM = 1;
const GROUP_DM = 3;
const isDm = (channel: any) => !!channel && (channel.type === DM || channel.type === GROUP_DM);

const ACTION_ROW = 1;
const BUTTON = 2;
const STYLE_SECONDARY = 2;
const STYLE_DANGER = 4;

const PAUSE_ID = "vc-dmwipe-pause";
const CANCEL_ID = "vc-dmwipe-cancel";
const REPORT_ID = "vc-dmwipe-report";

const MAX_INTERVAL = 5000;
const BULK_MAX_AGE = 13 * 24 * 60 * 60 * 1000;
const MAX_THROW_STREAK = 10;
const BAR_SLOTS = 22;
const HISTORY_LIMIT = 25;

const URL_RE = /https?:\/\/\S+/i;

const STATS_KEY = "DMWipe_stats";
const QUEUE_KEY = "DMWipe_queue";
const PENDING_KEY = "DMWipe_pending";

const toast = (text: string, variant: "default" | "success" | "critical" = "default") => showToast({ text, variant });

function channelLabel(id: string) {
    const c = ChannelStore.getChannel(id);
    if (!c) return "unknown channel";
    if (c.name) return c.name;
    const names = (c.recipients ?? []).map((uid: string) => UserStore.getUser(uid)?.username).filter(Boolean);
    return names.length ? names.join(", ") : "DM";
}

const hdr = (headers: any, name: string) => {
    if (!headers) return undefined;
    if (typeof headers.get === "function") return headers.get(name) ?? undefined;
    return headers[name] ?? headers[name.toUpperCase()];
};

// ---------------------------------------------------------------- settings

const settings = definePluginSettings({
    delay: {
        type: OptionType.SLIDER,
        description: "Minimum gap between requests in ms. With adaptive pacing on, Discord's rate limit headers set the real pace above this floor.",
        markers: [0, 10, 25, 50, 100, 200, 500],
        default: 25,
        stickToMarkers: false
    },
    adaptive: { type: OptionType.BOOLEAN, description: "Read Discord's X-RateLimit headers and pace to exactly what the bucket allows.", default: true },
    concurrency: { type: OptionType.NUMBER, description: "Requests in flight at once. Only hides round-trip latency, the rate limiter controls actual speed.", default: 4 },
    countFirst: { type: OptionType.BOOLEAN, description: "Scan the channel first so progress and ETA are accurate.", default: true },
    backup: {
        type: OptionType.SELECT,
        description: "Save every message as JSON before deleting.",
        options: [
            { label: "Off", value: "none", default: true },
            { label: "Clipboard", value: "clipboard" },
            { label: "Download .json", value: "file" },
            { label: "Both", value: "both" }
        ]
    },

    keepPinned: { type: OptionType.BOOLEAN, description: "Filter: keep pinned messages.", default: false },
    keepLast: { type: OptionType.NUMBER, description: "Filter: keep the newest N messages.", default: 0 },
    keepDays: { type: OptionType.NUMBER, description: "Filter: keep messages newer than N days.", default: 0 },
    keepLinks: { type: OptionType.BOOLEAN, description: "Filter: keep messages containing a link.", default: false },
    keepAttachments: { type: OptionType.BOOLEAN, description: "Filter: keep messages with attachments.", default: false },
    keepReactions: { type: OptionType.BOOLEAN, description: "Filter: keep messages that have reactions.", default: false },
    keepBots: { type: OptionType.BOOLEAN, description: "Filter: keep messages sent by bots.", default: false },
    keepRegex: { type: OptionType.STRING, description: "Filter: keep messages matching this regex. Empty disables it.", default: "" },

    stuckPasses: { type: OptionType.NUMBER, description: "Empty passes before giving up.", default: 5 },
    confirm: { type: OptionType.BOOLEAN, description: "Ask for confirmation before wiping.", default: true },
    notifyOnFinish: { type: OptionType.BOOLEAN, description: "Show a desktop notification when a run finishes.", default: true }
});

// ---------------------------------------------------------------- state

interface Session {
    channelId: string;
    cancelled: boolean;
    paused: boolean;
    crashed: boolean;
    deleted: number;
    failed: number;
    kept: number;
    passes: number;
    started: number;
    total: number;
    peakRate: number;
    mode: string;
}

interface Filters {
    keepPinned: boolean;
    keepBots: boolean;
    keepLinks: boolean;
    keepAttachments: boolean;
    keepReactions: boolean;
    regex: RegExp | null;
    cutoff: number;
}

interface Stats {
    runs: number;
    deleted: number;
    failed: number;
    seconds: number;
    fastest: number;
    lastAt: number;
    history: { at: number; channel: string; deleted: number; seconds: number; }[];
}

interface RunSnapshot {
    at: number;
    channelId: string;
    channel: string;
    deleted: number;
    failed: number;
    kept: number;
    passes: number;
    seconds: number;
    avg: number;
    peak: number;
    mode: string;
    interval: number;
    stopReason: string;
    error?: string;
    stack?: string;
}

const emptyStats = (): Stats => ({ runs: 0, deleted: 0, failed: 0, seconds: 0, fastest: 0, lastAt: 0, history: [] });

let session: Session | null = null;
let requestCancel: (() => void) | null = null;
let togglePause: (() => void) | null = null;
let stats: Stats = emptyStats();
let statsLoaded = false;
let wipeQueue: string[] = [];
let queueLoaded = false;

let lastUncaught: string | null = null;
let lastReport: RunSnapshot | null = null;
let sendingReport = false;

// ---------------------------------------------------------------- storage

async function loadStats() {
    if (statsLoaded) return stats;
    try {
        stats = (await DataStore.get(STATS_KEY)) ?? emptyStats();
        stats.history ??= [];
    } catch (e) { log("stats load failed", e); }
    statsLoaded = true;
    return stats;
}

const saveStats = () => DataStore.set(STATS_KEY, stats).catch(e => log("stats save failed", e));

async function loadQueue() {
    if (queueLoaded) return wipeQueue;
    try {
        wipeQueue = (await DataStore.get(QUEUE_KEY)) ?? [];
    } catch (e) { log("queue load failed", e); }
    queueLoaded = true;
    return wipeQueue;
}

const saveQueue = () => DataStore.set(QUEUE_KEY, wipeQueue).catch(e => log("queue save failed", e));

const setPending = (v: { channelId: string; startedAt: number; } | null) =>
    DataStore.set(PENDING_KEY, v).catch(e => log("pending write failed", e));

// ---------------------------------------------------------------- reporting

function captureSnapshot(s: Session | null, stopReason: string, extra: { interval?: number; error?: any; } = {}): RunSnapshot {
    const now = Date.now();
    const seconds = Math.max(1, (now - (s?.started ?? now)) / 1000);

    return {
        at: now,
        channelId: s?.channelId ?? "-",
        channel: s?.channelId ? channelLabel(s.channelId) : "-",
        deleted: s?.deleted ?? 0,
        failed: s?.failed ?? 0,
        kept: s?.kept ?? 0,
        passes: s?.passes ?? 0,
        seconds,
        avg: (s?.deleted ?? 0) / seconds,
        peak: s?.peakRate ?? 0,
        mode: s?.mode ?? "idle",
        interval: extra.interval ?? 0,
        stopReason,
        error: extra.error ? (extra.error.message ?? safeStr(extra.error)) : undefined,
        stack: extra.error?.stack ? String(extra.error.stack).split("\n").slice(0, 10).join("\n") : undefined
    };
}

function buildReport(snap: RunSnapshot) {
    const st = settings.store;

    return [
        `reason      ${snap.stopReason}`,
        snap.error ? `error       ${snap.error}` : null,
        snap.stack ? `stack\n${snap.stack}` : null,
        `channel     ${snap.channel} (${snap.channelId})`,
        `progress    deleted ${snap.deleted} | failed ${snap.failed} | kept ${snap.kept} | passes ${snap.passes} | ${fmtDur(snap.seconds)}`,
        `rate        ${snap.avg.toFixed(2)}/s avg | ${snap.peak.toFixed(2)}/s peak`,
        `mode        ${snap.mode} | interval ${Math.round(snap.interval)}ms`,
        `settings    adaptive=${st.adaptive} concurrency=${st.concurrency} delay=${st.delay} countFirst=${st.countFirst} backup=${st.backup} stuckPasses=${st.stuckPasses}`,
        `filters     keepLast=${st.keepLast} keepDays=${st.keepDays} pinned=${st.keepPinned} bots=${st.keepBots} links=${st.keepLinks} files=${st.keepAttachments} reactions=${st.keepReactions} regex=${st.keepRegex || "-"}`,
        `lifetime    ${stats.runs} runs | ${stats.deleted} deleted | ${stats.failed} failed`,
        `client      ${navigator.userAgent}`,
        `platform    ${navigator.platform}`,
        lastUncaught ? `uncaught    ${lastUncaught}` : null,
        `plugin      v${PLUGIN_VERSION}`
    ].filter(Boolean).join("\n");
}

function logChunks() {
    let text = logs.join("\n");
    const cap = LOG_CHUNKS * LOG_CHUNK_SIZE;
    if (text.length > cap) text = "...\n" + text.slice(-(cap - 4));

    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += LOG_CHUNK_SIZE) chunks.push(text.slice(i, i + LOG_CHUNK_SIZE));
    return chunks;
}

function buildPayload(snap: RunSnapshot) {
    const chunks = logChunks();

    return {
        username: REPORT_NAME,
        avatar_url: REPORT_AVATAR,
        thread_name: "DMWipe reports",
        content: `**DMWipe crash** · ${snap.stopReason} · ${snap.channel} · ${fmtNum(snap.deleted)} deleted · ${fmtDur(snap.seconds)} · ${snap.avg.toFixed(1)}/s`,
        embeds: [
            {
                title: "DMWipe Crash Report",
                color: 0xED4245,
                timestamp: new Date(snap.at).toISOString(),
                description: "```\n" + buildReport(snap).slice(0, REPORT_BODY_CAP) + "\n```",
                fields: chunks.map((c, i) => ({ name: i === 0 ? "Log" : `Log (${i + 1})`, value: "```\n" + c + "\n```" })),
                footer: { text: `DMWipe v${PLUGIN_VERSION}` }
            }
        ]
    };
}

async function postPayload(payload: any) {
    // Client RestAPI first, so no CORS involved. Absolute fetch as a fallback.
    try {
        const res = await RestAPI.post({ url: WEBHOOK_PATH, body: payload, retries: 2 });
        if (res?.ok) return true;
        log("report via RestAPI failed", res?.status, safeStr(res?.body)?.slice(0, 200));
    } catch (e) {
        log("report via RestAPI threw", e);
    }

    try {
        const res = await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (res.ok) return true;
        log("report via fetch failed", res.status);
    } catch (e) {
        log("report via fetch threw", e);
    }

    return false;
}

async function sendCrashReport(snap?: RunSnapshot, silent = false) {
    const target = snap ?? lastReport ?? captureSnapshot(session, session ? "manual (running)" : "manual");

    if (sendingReport) return;
    sendingReport = true;

    try {
        const ok = await postPayload(buildPayload(target));
        if (!ok) throw new Error("all transports failed");
        log("crash report sent", target.stopReason);
        toast("Crash report sent.");
    } catch (e) {
        log("crash report failed", e);
        if (!silent) toast("Crash report could not be sent.", "critical");
    } finally {
        sendingReport = false;
    }
}

// ---------------------------------------------------------------- limiter

interface Limiter {
    interval(): number;
    acquire(): Promise<boolean>;
    learn(headers: any): void;
    onThrottle(retryAfterMs: number): void;
    onSuccess(): void;
}

function createLimiter(minInterval: number, shouldHold: () => boolean, isCancelled: () => boolean): Limiter {
    const floor = Math.max(minInterval, 5);
    let interval = floor;
    let nextSlot = 0;
    let successStreak = 0;
    let lastThrottle = 0;

    return {
        interval: () => interval,

        async acquire() {
            while (shouldHold()) {
                if (isCancelled()) return false;
                await sleep(120);
            }
            if (isCancelled()) return false;

            const now = Date.now();
            const at = Math.max(nextSlot, now);
            nextSlot = at + interval;
            await wait(at - now, isCancelled);
            return !isCancelled();
        },

        learn(headers) {
            const limit = Number(hdr(headers, "x-ratelimit-limit"));
            const remaining = Number(hdr(headers, "x-ratelimit-remaining"));
            const resetAfter = Number(hdr(headers, "x-ratelimit-reset-after"));

            if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(resetAfter)) return;
            if (limit <= 0 || resetAfter <= 0) return;

            let target = (resetAfter * 1000) / limit;
            if (remaining < limit * 0.3) {
                target = Math.max(target, (resetAfter * 1000) / Math.max(remaining, 1));
            }

            interval = clamp(target, floor, MAX_INTERVAL);
        },

        onThrottle(retryAfterMs) {
            lastThrottle = Date.now();
            successStreak = 0;
            interval = Math.min(interval * 1.5 + 25, MAX_INTERVAL);
            nextSlot = Math.max(nextSlot, Date.now() + retryAfterMs);
        },

        onSuccess() {
            if (Date.now() - lastThrottle < 15_000) return;
            if (++successStreak < 25) return;
            successStreak = 0;
            interval = Math.max(interval * 0.9, floor);
        }
    };
}

// ---------------------------------------------------------------- filters

function buildFilters(): Filters {
    let regex: RegExp | null = null;
    const raw = settings.store.keepRegex?.trim();
    if (raw) {
        try {
            regex = new RegExp(raw, "i");
        } catch (e) {
            log("bad keepRegex, ignoring", e);
        }
    }

    const days = Number(settings.store.keepDays) || 0;

    return {
        keepPinned: settings.store.keepPinned,
        keepBots: settings.store.keepBots,
        keepLinks: settings.store.keepLinks,
        keepAttachments: settings.store.keepAttachments,
        keepReactions: settings.store.keepReactions,
        regex,
        cutoff: days > 0 ? Date.now() - days * 86_400_000 : 0
    };
}

function shouldKeep(msg: any, f: Filters): boolean {
    if (f.cutoff && Date.parse(msg.timestamp) >= f.cutoff) return true;
    if (f.keepPinned && msg.pinned) return true;
    if (f.keepBots && msg.author?.bot) return true;
    if (f.keepLinks && URL_RE.test(msg.content ?? "")) return true;
    if (f.keepAttachments && msg.attachments?.length) return true;
    if (f.keepReactions && msg.reactions?.length) return true;
    if (f.regex && f.regex.test(msg.content ?? "")) return true;
    return false;
}

// ---------------------------------------------------------------- components

function statusComponents(s: Session, finished: boolean) {
    const buttons: any[] = [];

    if (!finished) {
        buttons.push({
            type: BUTTON,
            style: STYLE_SECONDARY,
            label: s.paused ? "Resume" : "Pause",
            custom_id: PAUSE_ID,
            disabled: s.cancelled,
            onClick: () => pauseWipe()
        });
        buttons.push({
            type: BUTTON,
            style: STYLE_DANGER,
            label: s.cancelled ? "Cancelling..." : "Cancel wipe",
            emoji: { name: "🛑" },
            custom_id: CANCEL_ID,
            disabled: s.cancelled,
            onClick: () => cancelWipe()
        });
    } else if (s.crashed) {
        buttons.push({
            type: BUTTON,
            style: STYLE_DANGER,
            label: "Send Crash Report",
            custom_id: REPORT_ID,
            onClick: () => void sendCrashReport()
        });
    }

    return buttons.length ? [{ type: ACTION_ROW, components: buttons }] : [];
}

function cancelWipe() {
    if (requestCancel) requestCancel();
    else toast("No wipe is running.");
}

function pauseWipe() {
    if (togglePause) togglePause();
    else toast("No wipe is running.");
}

// ---------------------------------------------------------------- backup

function writeBackup(channelId: string, messages: any[], mode: string) {
    try {
        const payload = JSON.stringify(
            { channel: channelLabel(channelId), channelId, exportedAt: new Date().toISOString(), count: messages.length, messages },
            null,
            2
        );

        if (mode === "clipboard" || mode === "both") {
            copyToClipboard(payload);
            toast(`Backed up ${fmtNum(messages.length)} messages to clipboard.`);
        }

        if (mode === "file" || mode === "both") {
            const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `dmwipe-${channelId}-${Date.now()}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 15_000);
            toast(`Backed up ${fmtNum(messages.length)} messages to a file.`);
        }
    } catch (e) {
        log("backup failed", e);
        toast("Backup failed, see console.", "critical");
    }
}

// ---------------------------------------------------------------- requests

interface Ctx {
    s: Session;
    limiter: Limiter;
    bulkLimiter: Limiter;
    onSuccess(): void;
}

async function bulkDelete(channelId: string, ids: string[], ctx: Ctx): Promise<"ok" | "unsupported" | "failed"> {
    const { s, bulkLimiter } = ctx;

    for (let attempt = 1; attempt <= 5; attempt++) {
        if (s.cancelled) return "failed";
        if (!(await bulkLimiter.acquire())) return "failed";

        try {
            const res = await RestAPI.post({
                url: `/channels/${channelId}/messages/bulk-delete`,
                body: { messages: ids },
                retries: 0
            });

            bulkLimiter.learn(res.headers);

            if (res.ok) return "ok";

            if (res.status === 429) {
                const retryAfter = Number(res.body?.retry_after);
                bulkLimiter.onThrottle(Number.isFinite(retryAfter) ? retryAfter * 1000 + 300 : 1500);
                continue;
            }

            if (res.status >= 500) {
                await wait(800 * attempt, () => s.cancelled);
                continue;
            }

            log("bulk rejected", res.status, safeStr(res.body).slice(0, 160));
            return res.status === 400 || res.status === 403 || res.status === 404 ? "unsupported" : "failed";
        } catch (e) {
            const retryAfter = Number((e as any)?.retry_after ?? (e as any)?.body?.retry_after);
            bulkLimiter.onThrottle(Number.isFinite(retryAfter) ? retryAfter * 1000 + 500 : 1200 * attempt);
        }
    }

    return "failed";
}

async function deleteOne(channelId: string, messageId: string, ctx: Ctx): Promise<boolean> {
    const { s, limiter } = ctx;

    for (let attempt = 1; attempt <= 8; attempt++) {
        if (!(await limiter.acquire())) return false;

        try {
            const res = await RestAPI.del({
                url: `/channels/${channelId}/messages/${messageId}`,
                retries: 0
            });

            limiter.learn(res.headers);

            if (res.ok || res.status === 404) return true;

            if (res.status === 429) {
                const retryAfter = Number(res.body?.retry_after);
                limiter.onThrottle(Number.isFinite(retryAfter) ? retryAfter * 1000 + 300 : 1200);
                continue;
            }

            if (res.status >= 500) {
                await wait(800 * attempt, () => s.cancelled);
                continue;
            }

            log("skipping", messageId, "->", res.status);
            return false;
        } catch (e) {
            const retryAfter = Number((e as any)?.retry_after ?? (e as any)?.body?.retry_after);
            limiter.onThrottle(Number.isFinite(retryAfter) ? retryAfter * 1000 + 500 : 1200 * attempt);
        }
    }

    return false;
}

async function deleteMany(channelId: string, msgs: any[], ctx: Ctx, concurrency: number) {
    let next = 0;
    let deleted = 0;
    let failed = 0;

    const worker = async () => {
        for (;;) {
            if (ctx.s.cancelled) return;

            const msg = next < msgs.length ? msgs[next++] : undefined;
            if (!msg) return;

            const ok = await deleteOne(channelId, msg.id, ctx);

            if (ok) {
                deleted++;
                ctx.s.deleted++;
                ctx.onSuccess();
            } else if (!ctx.s.cancelled) {
                failed++;
                ctx.s.failed++;
            }
        }
    };

    const workers = clamp(concurrency, 1, Math.max(1, msgs.length));
    await Promise.all(Array.from({ length: workers }, worker));

    return { deleted, failed };
}

const isBulkable = (msg: any) => {
    const t = Date.parse(msg.timestamp);
    return Number.isFinite(t) && Date.now() - t < BULK_MAX_AGE;
};

// ---------------------------------------------------------------- scan

async function scanChannel(channelId: string, s: Session, f: Filters, collect: any[] | null, onTick: () => void) {
    let toDelete = 0;
    let kept = 0;
    let seen = 0;
    let cursor: string | undefined;
    const keepLast = Number(settings.store.keepLast) || 0;

    for (;;) {
        if (s.cancelled) break;

        const res = await RestAPI.get({
            url: `/channels/${channelId}/messages`,
            query: { limit: 100, ...(cursor ? { before: cursor } : {}) },
            retries: 3
        });

        if (!res.ok) {
            log("scan fetch failed", res.status);
            break;
        }

        const batch: any[] = res.body ?? [];
        if (!batch.length) break;

        for (const msg of batch) {
            if (collect) collect.push({
                id: msg.id,
                author: msg.author?.username,
                authorId: msg.author?.id,
                timestamp: msg.timestamp,
                content: msg.content,
                attachments: msg.attachments?.map((a: any) => a.url)
            });

            if (keepLast > 0 && seen === keepLast - 1) f.cutoff = Math.max(f.cutoff, Date.parse(msg.timestamp));
            seen++;

            if (shouldKeep(msg, f)) kept++;
            else toDelete++;
        }

        cursor = batch[batch.length - 1].id;
        s.total = toDelete;
        s.kept = kept;
        onTick();
        await wait(110, () => s.cancelled);
    }

    return { toDelete, kept };
}

// ---------------------------------------------------------------- pass

async function runPass(channelId: string, ctx: Ctx, cfg: any) {
    const { s } = ctx;
    let deleted = 0;
    let failed = 0;
    let cursor: string | undefined;
    let bulkFailures = 0;

    while (!s.cancelled) {
        if (cfg.limit && s.deleted >= cfg.limit) break;

        const res = await RestAPI.get({
            url: `/channels/${channelId}/messages`,
            query: { limit: 100, ...(cursor ? { before: cursor } : {}) },
            retries: 3
        });

        if (!res.ok) {
            log("fetch failed", res.status, "restarting");
            if (res.status === 429) ctx.limiter.onThrottle(1500);
            break;
        }

        const batch: any[] = res.body ?? [];
        if (!batch.length) break;

        cursor = batch[batch.length - 1].id;

        const bulkable: any[] = [];
        const individual: any[] = [];

        for (const msg of batch) {
            if (cfg.limit && s.deleted >= cfg.limit) break;
            if (shouldKeep(msg, cfg.filters)) continue;
            if (cfg.bulkEnabled && isBulkable(msg)) bulkable.push(msg);
            else individual.push(msg);
        }

        if (bulkable.length > 1) {
            const outcome = await bulkDelete(channelId, bulkable.map(m => m.id), ctx);

            if (outcome === "ok") {
                deleted += bulkable.length;
                s.deleted += bulkable.length;
                for (let i = 0; i < bulkable.length; i++) ctx.onSuccess();
            } else {
                individual.push(...bulkable);
                bulkFailures++;
                if (bulkFailures >= 2 && cfg.bulkEnabled) {
                    cfg.disableBulk();
                    log("bulk delete unavailable, using individual deletes");
                }
            }
        } else {
            individual.push(...bulkable);
        }

        if (individual.length) {
            const r = await deleteMany(channelId, individual, ctx, cfg.concurrency);
            deleted += r.deleted;
            failed += r.failed;
        }
    }

    return { deleted, failed };
}

// ---------------------------------------------------------------- core

async function wipeChannel(channelId: string, opts: { limit?: number; dry?: boolean; } = {}) {
    if (session) {
        toast("A wipe is already running. Use the buttons in the channel, or run /wipe again.", "critical");
        return null;
    }

    const channel = ChannelStore.getChannel(channelId);
    if (!isDm(channel)) {
        toast("That channel is not a DM.", "critical");
        return null;
    }

    const s: Session = {
        channelId, cancelled: false, paused: false, crashed: false, deleted: 0, failed: 0, kept: 0,
        passes: 0, started: Date.now(), total: 0, peakRate: 0, mode: "starting"
    };
    session = s;

    const { delay, adaptive, concurrency, countFirst, stuckPasses, backup, notifyOnFinish } = settings.store;
    const filters = buildFilters();
    const minInterval = adaptive ? clamp(delay, 5, 1000) : Math.max(delay, 5);

    const isCancelled = () => s.cancelled;
    const shouldHold = () => s.paused && !s.cancelled;

    const limiter = createLimiter(minInterval, shouldHold, isCancelled);
    const bulkLimiter = createLimiter(Math.max(minInterval, 300), shouldHold, isCancelled);

    const ctx: Ctx = {
        s, limiter, bulkLimiter,
        onSuccess: () => { limiter.onSuccess(); bulkLimiter.onSuccess(); }
    };

    let bulkEnabled = true;
    let stuck = 0;
    let throwStreak = 0;
    let stopReason = "all messages gone";
    let fatalError: any = null;
    let statusId: string | undefined;
    let ticking = true;

    const rate = () => {
        const r = s.deleted / Math.max(1, (Date.now() - s.started) / 1000);
        if (r > s.peakRate) s.peakRate = r;
        return r;
    };

    const renderStatus = () => {
        const r = rate();
        const secs = (Date.now() - s.started) / 1000;
        const lines: string[] = [];

        if (s.total > 0) {
            const pct = clamp((s.deleted / s.total) * 100, 0, 100);
            const filled = Math.round((pct / 100) * BAR_SLOTS);
            lines.push(`${"▰".repeat(filled)}${"▱".repeat(BAR_SLOTS - filled)}  ${pct.toFixed(1)}%`);
            lines.push(`${fmtNum(s.deleted)} / ${fmtNum(s.total)} deleted${s.kept ? `  (${fmtNum(s.kept)} kept)` : ""}`);
        } else {
            lines.push(`${fmtNum(s.deleted)} deleted${s.kept ? `  (${fmtNum(s.kept)} kept)` : ""}`);
        }

        const eta = r > 0.05 && s.total > s.deleted ? fmtDur((s.total - s.deleted) / r) : null;
        lines.push(`${r.toFixed(1)}/s · ${fmtDur(secs)} elapsed${eta ? ` · ETA ${eta}` : ""}`);
        lines.push(`${s.mode} · ${Math.round(limiter.interval())}ms · pass ${s.passes}${s.paused ? " · PAUSED" : ""}`);

        return `**DMWipe**\n\`\`\`\n${lines.join("\n")}\n\`\`\``;
    };

    const setStatus = (content: string, finished = false) => {
        if (!statusId) return;
        try {
            FluxDispatcher.dispatch({
                type: "MESSAGE_UPDATE",
                channelId,
                message: { id: statusId, channel_id: channelId, content, components: statusComponents(s, finished) }
            });
        } catch { /* ignore */ }
    };

    const ticker = setInterval(() => { if (ticking) setStatus(renderStatus()); }, 1200);

    requestCancel = () => {
        if (s.cancelled) return;
        s.cancelled = true;
        log("cancel requested");
        toast("Stopping after the current request...", "critical");
        setStatus("**DMWipe**\n```\nCancelling...\n```");
    };

    togglePause = () => {
        s.paused = !s.paused;
        log(s.paused ? "paused" : "resumed");
        toast(s.paused ? "Wipe paused." : "Wipe resumed.");
        setStatus(renderStatus());
    };

    try {
        const msg: any = sendBotMessage(channelId, {
            content: "**DMWipe**\n```\nStarting...\n```",
            components: statusComponents(s, false)
        } as any);
        statusId = msg?.id;
    } catch (e) {
        log("could not post status message", e);
    }

    try {
        void showNotification({
            title: "DMWipe",
            body: `Wiping ${channelLabel(channelId)}`,
            richBody: (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <BaseText size="sm">Wiping {channelLabel(channelId)}. Click to stop.</BaseText>
                    <div style={{ display: "flex", gap: "8px" }}>
                        <Button variant="secondary" size="small" onClick={pauseWipe}>Pause</Button>
                        <Button variant="dangerPrimary" size="small" onClick={cancelWipe}>Cancel</Button>
                    </div>
                </div>
            ),
            permanent: true,
            noPersist: true
        });
    } catch { /* ignore */ }

    await setPending({ channelId, startedAt: s.started });
    log(`start ${channelLabel(channelId)}: floor ${minInterval}ms, adaptive ${adaptive}, concurrency ${concurrency}`);

    try {
        if (opts.dry) s.mode = "dry run";

        const needsScan = countFirst || Number(settings.store.keepLast) > 0 || backup !== "none" || opts.dry;
        const collected: any[] = [];

        if (needsScan) {
            s.mode = opts.dry ? "dry run" : "scanning";
            const scanned = await scanChannel(channelId, s, filters, backup === "none" ? null : collected, () => setStatus(renderStatus()));
            s.total = opts.limit ? Math.min(scanned.toDelete, opts.limit) : scanned.toDelete;
            s.kept = scanned.kept;
            log(`scanned: ${s.total} to delete, ${s.kept} kept`);

            if (backup !== "none" && collected.length) writeBackup(channelId, collected, backup);

            if (opts.dry) {
                stopReason = "dry run";
                throw { dry: true };
            }
        }

        while (!s.cancelled) {
            s.passes++;
            s.mode = bulkEnabled ? "bulk" : `individual x${concurrency}`;

            let pass: { deleted: number; failed: number; };
            try {
                pass = await runPass(channelId, ctx, {
                    filters,
                    limit: opts.limit,
                    concurrency: clamp(concurrency, 1, 8),
                    get bulkEnabled() { return bulkEnabled; },
                    disableBulk: () => { bulkEnabled = false; }
                });
                throwStreak = 0;
            } catch (e) {
                log(`pass ${s.passes} threw, restarting`, e);
                throwStreak++;
                limiter.onThrottle(1000);

                if (throwStreak > MAX_THROW_STREAK) {
                    stopReason = `gave up after ${throwStreak} failed restarts`;
                    break;
                }

                setStatus(`**DMWipe**\n\`\`\`\nRestarting... ${fmtNum(s.deleted)} deleted\n\`\`\``);
                await wait(Math.min(1500 * throwStreak, 15_000), isCancelled);
                continue;
            }

            if (opts.limit && s.deleted >= opts.limit) { stopReason = "limit reached"; break; }
            if (pass.deleted === 0 && pass.failed === 0) { stopReason = "all messages gone"; break; }

            if (pass.deleted === 0) {
                stuck++;
                if (stuck > stuckPasses) { stopReason = "no progress"; break; }
                await wait(4000 * stuck, isCancelled);
            } else {
                stuck = 0;
            }
        }

        if (s.cancelled) stopReason = "stopped";
    } catch (e: any) {
        if (!e?.dry) {
            log("fatal", e);
            fatalError = e;
            stopReason = "fatal error";
        }
    } finally {
        ticking = false;
        clearInterval(ticker);
        session = null;
        requestCancel = null;
        togglePause = null;
    }

    const secs = Math.max(1, (Date.now() - s.started) / 1000);
    const avg = s.deleted / secs;
    const abnormal = stopReason === "fatal error" || stopReason.startsWith("gave up") || stopReason === "no progress";
    s.crashed = abnormal;

    if (abnormal) {
        lastReport = captureSnapshot(s, stopReason, { interval: limiter.interval(), error: fatalError });
        log("captured crash report:", stopReason);
        void sendCrashReport(lastReport, true);
    }

    const card = [
        `**DMWipe: ${stopReason}**`,
        "```",
        `channel    ${channelLabel(channelId).slice(0, 18)}`,
        `deleted    ${fmtNum(s.deleted).padStart(9)}`,
        `failed     ${fmtNum(s.failed).padStart(9)}`,
        `kept       ${fmtNum(s.kept).padStart(9)}`,
        `duration   ${fmtDur(secs).padStart(9)}`,
        `average    ${(avg.toFixed(1) + "/s").padStart(9)}`,
        `peak       ${(s.peakRate.toFixed(1) + "/s").padStart(9)}`,
        "```"
    ].join("\n");

    setStatus(card, true);

    if (!opts.dry) {
        stats.runs++;
        stats.deleted += s.deleted;
        stats.failed += s.failed;
        stats.seconds += secs;
        stats.fastest = Math.max(stats.fastest, s.peakRate);
        stats.lastAt = Date.now();
        stats.history.unshift({ at: Date.now(), channel: channelLabel(channelId), deleted: s.deleted, seconds: secs });
        stats.history = stats.history.slice(0, HISTORY_LIMIT);
        await saveStats();
        await setPending(null);
    }

    log(stopReason, `${s.deleted} deleted, ${s.failed} failed, ${avg.toFixed(2)}/s`);
    toast(`DMWipe ${stopReason}: ${fmtNum(s.deleted)} deleted (${avg.toFixed(1)}/s)`, s.failed ? "critical" : "success");

    if (notifyOnFinish && !opts.dry) {
        try {
            void showNotification({
                title: `DMWipe ${stopReason}`,
                body: `${fmtNum(s.deleted)} messages deleted from ${channelLabel(channelId)} in ${fmtDur(secs)}.`,
                noPersist: true
            });
        } catch { /* ignore */ }
    }

    return { deleted: s.deleted, failed: s.failed, kept: s.kept, stopped: s.cancelled, stopReason };
}

// ---------------------------------------------------------------- queue

async function runQueue() {
    if (session) {
        toast("A wipe is already running.", "critical");
        return;
    }

    const queued = await loadQueue();
    const ids = queued.filter(id => isDm(ChannelStore.getChannel(id)));

    if (!ids.length) {
        toast("Wipe queue is empty.");
        return;
    }

    toast(`Running wipe queue: ${ids.length} channel(s).`);

    for (const id of ids) {
        const result = await wipeChannel(id);
        if (!result || result.stopped) break;
        wipeQueue = wipeQueue.filter(q => q !== id);
        await saveQueue();
    }
}

function toggleQueue(channelId: string) {
    void (async () => {
        await loadQueue();
        const had = wipeQueue.includes(channelId);
        wipeQueue = had ? wipeQueue.filter(id => id !== channelId) : [...wipeQueue, channelId];
        await saveQueue();
        toast(had ? `Removed ${channelLabel(channelId)} from queue.` : `Queued ${channelLabel(channelId)}. (${wipeQueue.length} in queue)`);
    })();
}

// ---------------------------------------------------------------- modals

async function openStats() {
    await loadStats();

    const avg = stats.seconds > 0 ? stats.deleted / stats.seconds : 0;

    openModal(props => (
        <ModalRoot {...props}>
            <ModalHeader>
                <BaseText tag="h2" size="lg" weight="semibold">DMWipe stats</BaseText>
            </ModalHeader>
            <ModalContent>
                <div style={{ fontFamily: "var(--font-code)", fontSize: "13px", lineHeight: "1.7", whiteSpace: "pre" }}>
                    {[
                        `runs        ${fmtNum(stats.runs)}`,
                        `deleted     ${fmtNum(stats.deleted)}`,
                        `failed      ${fmtNum(stats.failed)}`,
                        `time        ${fmtDur(stats.seconds)}`,
                        `average     ${avg.toFixed(2)}/s`,
                        `fastest     ${stats.fastest.toFixed(2)}/s`,
                        `last run    ${stats.lastAt ? new Date(stats.lastAt).toLocaleString() : "never"}`,
                        "",
                        "recent runs:",
                        ...(stats.history.length
                            ? stats.history.slice(0, 8).map(h => `  ${new Date(h.at).toLocaleDateString()}  ${String(h.deleted).padStart(6)}  ${h.channel}`)
                            : ["  none yet"])
                    ].join("\n")}
                </div>
            </ModalContent>
            <ModalFooter>
                <Button
                    variant="secondary"
                    onClick={() => {
                        stats = emptyStats();
                        void saveStats();
                        props.onClose();
                        toast("Stats reset.");
                    }}
                >
                    Reset
                </Button>
                <Button variant="primary" onClick={props.onClose}>Close</Button>
            </ModalFooter>
        </ModalRoot>
    ));
}

function confirmAndWipe(channelId: string, limit?: number, dry?: boolean) {
    if (!settings.store.confirm && !dry) {
        void wipeChannel(channelId, { limit, dry });
        return;
    }

    const label = channelLabel(channelId);

    openModal(props => (
        <ModalRoot {...props}>
            <ModalHeader>
                <BaseText tag="h2" size="lg" weight="semibold">{dry ? "Dry run" : "Delete all messages"}</BaseText>
            </ModalHeader>
            <ModalContent>
                <BaseText>
                    {dry
                        ? `Scan ${label} and report what would be deleted, without deleting anything.`
                        : `Permanently delete ${limit ? `up to ${fmtNum(limit)}` : "every matching"} message in ${label}? This cannot be undone.`}
                </BaseText>
            </ModalContent>
            <ModalFooter>
                <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
                <Button
                    variant={dry ? "primary" : "dangerPrimary"}
                    onClick={() => {
                        props.onClose();
                        void wipeChannel(channelId, { limit, dry });
                    }}
                >
                    {dry ? "Scan" : "Delete"}
                </Button>
            </ModalFooter>
        </ModalRoot>
    ));
}

// ---------------------------------------------------------------- menus

const channelContextPatch: NavContextMenuPatchCallback = (children, props) => {
    const channel = props?.channel;
    if (!isDm(channel)) return;

    const queued = wipeQueue.includes(channel.id);

    children.push(
        <Menu.MenuItem
            id="vc-dmwipe-wipe"
            label={session ? "Delete All Messages (running)" : "Delete All Messages"}
            action={() => confirmAndWipe(channel.id)}
        />,
        <Menu.MenuItem id="vc-dmwipe-dry" label="Dry Run (preview)" action={() => confirmAndWipe(channel.id, undefined, true)} />,
        <Menu.MenuItem id="vc-dmwipe-pause" label="Pause / Resume Wipe" disabled={!session} action={pauseWipe} />,
        <Menu.MenuItem id="vc-dmwipe-cancel" label="Cancel Wipe" disabled={!session || session.cancelled} action={cancelWipe} />,
        <Menu.MenuItem
            id="vc-dmwipe-queue"
            label={queued ? "Remove from Wipe Queue" : "Add to Wipe Queue"}
            action={() => toggleQueue(channel.id)}
        />,
        <Menu.MenuItem
            id="vc-dmwipe-runqueue"
            label={`Run Wipe Queue (${wipeQueue.length})`}
            disabled={!wipeQueue.length || !!session}
            action={() => void runQueue()}
        />,
        <Menu.MenuItem id="vc-dmwipe-report" label="Send Crash Report" action={() => void sendCrashReport()} />,
        <Menu.MenuItem id="vc-dmwipe-stats" label="DMWipe Stats" action={() => void openStats()} />
    );
};

// ---------------------------------------------------------------- listeners

const onWindowError = (e: ErrorEvent) => {
    lastUncaught = `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`;
};

const onUnhandledRejection = (e: PromiseRejectionEvent) => {
    lastUncaught = `unhandled rejection: ${e.reason?.message ?? safeStr(e.reason)}`;
};

// ---------------------------------------------------------------- plugin

export default definePlugin({
    name: "DMWipe",
    description: "Bulk-delete DMs with a live progress bar and ETA. Paces off Discord's rate limit headers, filters what to keep, backs up before deleting, keeps stats, and files its own crash reports.",

    authors: [{ name: "Hyawii", id: 1082686076491137115 }],
    settings,

    contextMenus: {
        "channel-context": channelContextPatch
    },

    flux: {
        INTERACTION_CREATE(data: any) {
            const id = data?.data?.custom_id;
            if (id === CANCEL_ID) cancelWipe();
            else if (id === PAUSE_ID) pauseWipe();
            else if (id === REPORT_ID) void sendCrashReport();
        }
    },

    async start() {
        window.addEventListener("error", onWindowError);
        window.addEventListener("unhandledrejection", onUnhandledRejection);

        await loadQueue();
        await loadStats();

        try {
            const pending = await DataStore.get(PENDING_KEY);
            if (!pending?.channelId || !ChannelStore.getChannel(pending.channelId)) return;

            const label = channelLabel(pending.channelId);
            void showNotification({
                title: "DMWipe",
                body: `A wipe of ${label} was interrupted.`,
                richBody: (
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <BaseText size="sm">A wipe of {label} was interrupted. Run it again?</BaseText>
                        <div style={{ display: "flex", gap: "8px" }}>
                            <Button variant="primary" size="small" onClick={() => { void setPending(null); void wipeChannel(pending.channelId); }}>
                                Resume
                            </Button>
                            <Button variant="secondary" size="small" onClick={() => void setPending(null)}>
                                Dismiss
                            </Button>
                        </div>
                    </div>
                ),
                permanent: true,
                noPersist: true
            });
        } catch (e) {
            log("resume check failed", e);
        }
    },

    stop() {
        window.removeEventListener("error", onWindowError);
        window.removeEventListener("unhandledrejection", onUnhandledRejection);
    },

    commands: [
        {
            name: "wipe",
            description: "Delete every message in the current DM. Run again while it is going to stop it.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                { name: "limit", description: "Maximum number of messages to delete. Empty = all.", type: ApplicationCommandOptionType.NUMBER, required: false },
                { name: "delay", description: "Minimum gap between requests in ms (overrides the setting).", type: ApplicationCommandOptionType.NUMBER, required: false },
                { name: "dry", description: "Only scan and report, do not delete.", type: ApplicationCommandOptionType.BOOLEAN, required: false }
            ],
            execute: async (args, ctx) => {
                const channelId = ctx.channel.id;

                if (session) {
                    cancelWipe();
                    return;
                }

                const limitArg = Number(args.find(a => a.name === "limit")?.value);
                const delayArg = Number(args.find(a => a.name === "delay")?.value);
                const dry = !!args.find(a => a.name === "dry")?.value;
                const limit = Number.isFinite(limitArg) ? limitArg : undefined;

                const oldDelay = settings.store.delay;
                if (Number.isFinite(delayArg)) settings.store.delay = delayArg;

                await wipeChannel(channelId, { limit, dry });

                settings.store.delay = oldDelay;
            }
        },
        {
            name: "wipequeue",
            description: "Run every DM in the wipe queue, one after another.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async () => { await runQueue(); }
        },
        {
            name: "wipestats",
            description: "Show DMWipe lifetime stats.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async () => { await openStats(); }
        }
    ]
});
