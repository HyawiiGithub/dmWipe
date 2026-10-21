/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Venice
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import type { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { ModalContent, ModalFooter, ModalHeader, ModalRoot } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, Menu, openModal, RestAPI, showToast, UserStore } from "@webpack/common";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const jitter = (ms: number) => ms + Math.random() * Math.min(ms * 0.25, 250);

const DM = 1;
const GROUP_DM = 3;
const isDm = (channel: any) => !!channel && (channel.type === DM || channel.type === GROUP_DM);

// Pacing ceiling. The auto-throttle never goes past this, no matter how hard Discord pushes back.
const MAX_PACE = 4000;
// Consecutive thrown passes before the supervisor gives up entirely.
const MAX_THROW_STREAK = 10;

const toast = (text: string, variant: "default" | "success" | "critical" = "default") => showToast({ text, variant });

const settings = definePluginSettings({
    delay: {
        type: OptionType.SLIDER,
        description: "Starting gap between deletions (ms). The plugin raises this automatically whenever Discord throttles, so this is a floor, not a fixed speed.",
        markers: [100, 200, 300, 500, 750, 1000, 1500],
        default: 500,
        stickToMarkers: false
    },
    stuckPasses: {
        type: OptionType.NUMBER,
        description: "How many full passes that delete nothing before giving up. Raise it for stubborn channels.",
        default: 5
    },
    onlyOwnMessages: {
        type: OptionType.BOOLEAN,
        description: "Only delete messages you sent. Skips the other person's messages.",
        default: false
    },
    skipPinned: {
        type: OptionType.BOOLEAN,
        description: "Keep pinned messages.",
        default: false
    },
    confirm: {
        type: OptionType.BOOLEAN,
        description: "Ask for confirmation before wiping.",
        default: true
    }
});

interface Session {
    cancelled: boolean;
    deleted: number;
    failed: number;
    passes: number;
    started: number;
}

interface PassResult {
    deleted: number;
    failed: number;
}

let session: Session | null = null;

function postProgress(channelId: string, content: string): string | undefined {
    try {
        const msg: any = sendBotMessage(channelId, { content });
        return msg?.id;
    } catch (e) {
        console.warn("[DMWipe] could not post progress message", e);
        return undefined;
    }
}

// Deletes one message. Waits out 429s using the server's own retry_after, retries
// 5xx and network blips, treats 404 as success, and bumps the run's pace on throttle.
async function deleteOne(channelId: string, messageId: string, bumpPace: () => void): Promise<boolean> {
    const MAX_ATTEMPTS = 8;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const res = await RestAPI.del({
                url: `/channels/${channelId}/messages/${messageId}`,
                retries: 0
            });

            if (res.ok || res.status === 404) return true;

            if (res.status === 429) {
                bumpPace();
                const retryAfter = Number(res.body?.retry_after);
                await sleep(Math.min((Number.isFinite(retryAfter) ? retryAfter * 1000 : 1500) + 400, 30_000));
                continue;
            }

            if (res.status >= 500) {
                await sleep(Math.min(1000 * attempt, 15_000));
                continue;
            }

            // 403/401 and anything else: retrying won't help, but the run keeps going.
            console.warn("[DMWipe] skipping", messageId, "->", res.status);
            return false;
        } catch (e) {
            // Some RestAPI builds throw on 429 instead of returning it.
            const retryAfter = Number((e as any)?.retry_after ?? (e as any)?.body?.retry_after);
            bumpPace();
            await sleep(Math.min(Number.isFinite(retryAfter) ? retryAfter * 1000 + 500 : 1500 * attempt, 30_000));
        }
    }

    console.warn("[DMWipe] gave up on", messageId);
    return false;
}

// One full sweep of the channel, newest first. Returns what it managed so the
// supervisor can decide whether to go around again.
async function runPass(channelId: string, s: Session, cfg: {
    meId?: string;
    onlyOwnMessages: boolean;
    skipPinned: boolean;
    limit?: number;
    pace(): number;
    bumpPace(): void;
}): Promise<PassResult> {
    let deleted = 0;
    let failed = 0;
    let cursor: string | undefined;

    while (!s.cancelled) {
        if (cfg.limit && s.deleted + deleted >= cfg.limit) break;

        const res = await RestAPI.get({
            url: `/channels/${channelId}/messages`,
            query: { limit: 100, ...(cursor ? { before: cursor } : {}) },
            retries: 3
        });

        if (!res.ok) {
            console.warn("[DMWipe] fetch failed", res.status, "- ending pass so it can restart");
            if (res.status === 429) cfg.bumpPace();
            break;
        }

        const batch: any[] = res.body ?? [];
        if (!batch.length) break;

        // Oldest message of this batch becomes the next cursor. Survives deletion,
        // since `before` filters on snowflake ids rather than live rows.
        cursor = batch[batch.length - 1].id;

        for (const msg of batch) {
            if (s.cancelled) break;
            if (cfg.limit && s.deleted + deleted >= cfg.limit) break;
            if (cfg.skipPinned && msg.pinned) continue;
            if (cfg.onlyOwnMessages && msg.author?.id !== cfg.meId) continue;

            const ok = await deleteOne(channelId, msg.id, cfg.bumpPace);

            // Counted here, not at the end of the pass, so nothing is lost if the pass throws.
            if (ok) { deleted++; s.deleted++; }
            else { failed++; s.failed++; }

            await sleep(jitter(cfg.pace()));
        }
    }

    return { deleted, failed };
}

async function wipeChannel(channelId: string, opts: { limit?: number; } = {}) {
    if (session) {
        toast("A wipe is already running. Run /wipe again to stop it.", "critical");
        return;
    }

    const channel = ChannelStore.getChannel(channelId);
    if (!isDm(channel)) {
        toast("That channel isn't a DM.", "critical");
        return;
    }

    const s: Session = { cancelled: false, deleted: 0, failed: 0, passes: 0, started: Date.now() };
    session = s;

    const meId = UserStore.getCurrentUser()?.id;
    const { delay, onlyOwnMessages, skipPinned, stuckPasses } = settings.store;

    let pace = Math.max(delay, 40);
    let stuck = 0;
    let throwStreak = 0;
    let stopReason = "all messages gone";
    let lastReport = 0;

    const bumpPace = () => {
        const next = Math.min(Math.round(pace * 1.5) + 50, MAX_PACE);
        if (next !== pace) {
            pace = next;
            console.log(`[DMWipe] throttled, pacing is now ${pace}ms`);
        }
    };

    const report = (text: string, force = false) => {
        const now = Date.now();
        if (!force && now - lastReport < 3000) return;
        lastReport = now;
        toast(text);
    };

    console.log("[DMWipe] starting, base pace", pace, "ms");
    postProgress(channelId, "Deleting messages...");

    try {
        while (!s.cancelled) {
            s.passes++;

            let pass: PassResult;
            try {
                pass = await runPass(channelId, s, {
                    meId, onlyOwnMessages, skipPinned,
                    limit: opts.limit,
                    pace: () => pace,
                    bumpPace
                });
                throwStreak = 0;
            } catch (e) {
                console.warn(`[DMWipe] pass ${s.passes} threw, restarting`, e);
                throwStreak++;
                bumpPace();

                if (throwStreak > MAX_THROW_STREAK) {
                    stopReason = `gave up after ${throwStreak} consecutive failed restarts`;
                    break;
                }

                report(`Restarting (${s.deleted} deleted so far)`, true);
                await sleep(Math.min(1500 * throwStreak, 15_000) + Math.random() * 500);
                continue;
            }

            report(`Pass ${s.passes}: ${s.deleted} deleted, ${s.failed} failed`);

            if (opts.limit && s.deleted >= opts.limit) { stopReason = "limit reached"; break; }
            if (pass.deleted === 0 && pass.failed === 0) { stopReason = "all messages gone"; break; }

            if (pass.deleted === 0) {
                stuck++;
                if (stuck > stuckPasses) {
                    stopReason = `stopped after ${stuck} passes with no progress`;
                    break;
                }
                console.log(`[DMWipe] empty pass ${stuck}/${stuckPasses}, waiting before retrying`);
                await sleep(4000 * stuck);
            } else {
                stuck = 0;
            }
        }

        if (s.cancelled) stopReason = "stopped";
    } catch (e) {
        console.error("[DMWipe] fatal", e);
        stopReason = "fatal error";
    } finally {
        session = null;
    }

    const secs = Math.round((Date.now() - s.started) / 1000);
    const summary = `DMWipe ${stopReason}. Deleted ${s.deleted}${s.failed ? `, ${s.failed} could not be deleted` : ""} in ${s.passes} pass(es), ${secs}s.`;
    console.log("[DMWipe]", summary);
    toast(summary, s.failed ? "critical" : "success");

    postProgress(channelId, summary);
    return { deleted: s.deleted, failed: s.failed, passes: s.passes };
}

function confirmAndWipe(channelId: string, limit?: number) {
    if (!settings.store.confirm) {
        void wipeChannel(channelId, { limit });
        return;
    }

    const name = ChannelStore.getChannel(channelId)?.name || "this DM";

    openModal(props => (
        <ModalRoot {...props}>
            <ModalHeader>
                <BaseText tag="h2" size="lg" weight="semibold">Delete all messages</BaseText>
            </ModalHeader>
            <ModalContent>
                <BaseText>
                    Permanently delete {limit ? `up to ${limit}` : "every"} message in {name}? This cannot be undone.
                </BaseText>
            </ModalContent>
            <ModalFooter>
                <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
                <Button
                    variant="dangerPrimary"
                    onClick={() => {
                        props.onClose();
                        void wipeChannel(channelId, { limit });
                    }}
                >
                    Delete
                </Button>
            </ModalFooter>
        </ModalRoot>
    ));
}

const channelContextPatch: NavContextMenuPatchCallback = (children, props) => {
    const channel = props?.channel;
    if (!isDm(channel)) return;

    children.push(
        <Menu.MenuItem
            id="vc-dmwipe-wipe"
            label={session ? "Delete All Messages (running)" : "Delete All Messages"}
            action={() => confirmAndWipe(channel.id)}
        />,
        <Menu.MenuItem
            id="vc-dmwipe-stop"
            label="Stop Wipe"
            disabled={!session}
            action={() => {
                if (!session) return;
                session.cancelled = true;
                toast("Stopping after the current message...", "critical");
            }}
        />
    );
};

export default definePlugin({
    name: "DMWipe",
    description: "Bulk-delete every message in a DM or group DM. Self-throttles on rate limits and auto-restarts until the channel is empty.",
    authors: [{ name: "Venice", id: 0n }],
    settings,

    contextMenus: {
        "channel-context": channelContextPatch
    },

    commands: [
        {
            name: "wipe",
            description: "Delete every message in the current DM. Run again while it's going to stop it.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "limit",
                    description: "Maximum number of messages to delete. Empty = all.",
                    type: ApplicationCommandOptionType.NUMBER,
                    required: false
                },
                {
                    name: "delay",
                    description: "Starting gap between deletes in ms (overrides the setting).",
                    type: ApplicationCommandOptionType.NUMBER,
                    required: false
                }
            ],
            execute: async (args, ctx) => {
                const channelId = ctx.channel.id;

                if (session) {
                    session.cancelled = true;
                    sendBotMessage(channelId, { content: "Stopping after the current message..." });
                    return;
                }

                const limitArg = Number(args.find(a => a.name === "limit")?.value);
                const delayArg = Number(args.find(a => a.name === "delay")?.value);
                const limit = Number.isFinite(limitArg) ? limitArg : undefined;

                const oldDelay = settings.store.delay;
                if (Number.isFinite(delayArg)) settings.store.delay = delayArg;

                const result = await wipeChannel(channelId, { limit });
                settings.store.delay = oldDelay;

                if (result) {
                    sendBotMessage(channelId, {
                        content: `Done. Deleted ${result.deleted} messages${result.failed ? `, ${result.failed} could not be deleted` : ""}.`
                    });
                }
            }
        }
    ]
});
