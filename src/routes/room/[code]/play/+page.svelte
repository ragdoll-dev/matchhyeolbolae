<!--
  src/routes/room/[code]/play/+page.svelte

  v28 - "방 나가기" 버튼이 실제로 DB 에서 플레이어를 제거하지 않던 버그 수정
  - 근본 원인: handleLeaveRoom 이 goto('/') 로 페이지만 이동시키고
    leave_room/cancel_room RPC 를 전혀 호출하지 않았음.
    -> players 행이 DB 에 그대로 남아있어 cleanup_room_if_empty 트리거가 발동하지 않고,
       하트비트가 끊긴 뒤 1분 cron(좀비 방 안전망)에서야 뒤늦게 정리되던 문제.
  - 수정: 방장이면 cancel_room, 참가자면 leave_room 을 먼저 호출해
    players 행을 실제로 삭제한 뒤 이동. 이러면:
      - 혼자(솔로) 플레이 중 나가기 -> 즉시 players 0명 -> 트리거 즉시 발동 -> 방 삭제
      - 여러 명 중 한 명 나가기 -> 남은 인원 있으므로 방은 유지, 본인만 제거
      - 마지막 남은 한 명이 나가기 -> 즉시 트리거 발동 -> 방 삭제
-->
<script lang="ts">
    import { goto } from '$app/navigation';
    import { page } from '$app/stores';
    import {
        FRAME_HEIGHT,
        FRAME_WIDTH,
        getIdleFramePosition,
        sheetUrl,
        type AvatarGender
    } from '$lib/avatarSprite';
    import { toErrorMessage } from '$lib/errorMessage';
    import { getRoomPlayerId, saveRoomPlayerId } from '$lib/roomPlayerStorage';
    import { joinRoomPresence, type RoomPresenceHandle } from '$lib/roomPresence';
    import {
        subscribeToRoom,
        unsubscribeFromRoom,
        type ChatMessageRow,
        type GameSessionRow,
        type PlayerRow,
        type RoomRow
    } from '$lib/roomRealtime';
    import { msUntilDeadline, syncServerClock } from '$lib/serverClock';
    import { supabase } from '$lib/supabaseClient';
    import type { RealtimeChannel } from '@supabase/supabase-js';
    import { onDestroy, onMount, tick } from 'svelte';


    const roomCode = $page.params.code;
    const BUBBLE_VISIBLE_MS = 4000;
    const BOUNCE_DURATION_MS = 500;
    const TOTAL_SEATS = 16;
    const CHAT_MAX_LENGTH = 14;
    const HINT_POLL_INTERVAL_MS = 250;
    const HINT_POLL_MAX_ATTEMPTS = 10;
    const CHANNEL_WARMUP_GRACE_MS = 3000;


    type BubbleState = {
        text: string;
        isCorrect: boolean;
        expiresAt: number;
        pending?: boolean;
    };


    type SendMessageResult = {
        is_correct?: boolean;
        won_race?: boolean;
    };


    type ChatLogEntry = {
        id: string;
        nickname: string;
        message: string;
        isCorrect: boolean;
    };


    let room = $state<RoomRow | null>(null);
    let players = $state<PlayerRow[]>([]);
    let session = $state<GameSessionRow | null>(null);
    let currentPrompt = $state<string | null>(null);
    let currentCorrectAnswers = $state<string[] | null>(null);
    let currentHint = $state<string | null>(null);
    let isHintVisible = $state(false);
    let isRequestingHint = $state(false);
    let hintRequesterCount = $state(0);
    let hintTotalPlayers = $state(0);
    let previousQuestionId = $state<string | null>(null);


    let isRequestingSkip = $state(false);
    let skipRequesterCount = $state(0);
    let skipTotalPlayers = $state(0);
    let hasTriggeredSkipAdvance = $state(false);


    let isLeavingRoom = $state(false);


    let bubbles = $state<Record<string, BubbleState>>({});
    let bouncingPlayerIds = $state<Record<string, true>>({});
    let correctOverlay = $state<Record<string, true>>({});
    let wrongOverlay = $state<Record<string, true>>({});
    let chatLog = $state<ChatLogEntry[]>([]);
    let seenChatMessageIds = new Set<string>();


    let firstCorrectAt = $state<Record<string, string>>({});


    let myPlayerId = $state<string | null>(null);
    let chatInput = $state('');
    let pendingMessageText = $state<string | null>(null);
    let chatInputRef: HTMLInputElement | null = null;
    let chatLogRef: HTMLDivElement | null = null;
    let chatLogResizeObserver: ResizeObserver | null = null;


    let clockSyncError = $state<string | null>(null);
    let isClockSynced = $state(false);
    let nowTick = $state(Date.now());
    let isLoading = $state(true);
    let loadError = $state<string | null>(null);
    let actionError = $state<string | null>(null);
    let isRevealing = $state(false);
    let isAdvancing = $state(false);
    let isSendingMessage = $state(false);
    let revealedForSessionId = $state<string | null>(null);
    let advancedForSessionId = $state<string | null>(null);


    let channel: RealtimeChannel | null = null;
    let presenceHandle: RoomPresenceHandle | null = null;
    let tickTimer: ReturnType<typeof setInterval> | null = null;
    let bounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};
    let hintPollTimer: ReturnType<typeof setTimeout> | null = null;
    let skipPollTimer: ReturnType<typeof setTimeout> | null = null;
    let channelReadyAt: number | null = null;


    let myPlayer = $derived(players.find((player) => player.id === myPlayerId) ?? null);
    let isHost = $derived(myPlayer?.is_host === true);


    let remainingSeconds = $derived.by(() => {
        void nowTick;
        if (!session) return 0;
        const targetIso = session.phase === 'question' ? session.submission_deadline_at : session.next_round_at;
        if (!targetIso) return 0;
        return Math.max(0, Math.ceil(msUntilDeadline(targetIso) / 1000));
    });


    let myAlreadyCorrect = $derived(
        session?.phase === 'question' &&
        myPlayerId !== null &&
        bubbles[myPlayerId]?.isCorrect === true
    );


    let seats = $derived.by(() => {
        const slots: (PlayerRow | null)[] = new Array(TOTAL_SEATS).fill(null);
        const host = players.find((p) => p.is_host);

        if (host) slots[8] = host;

        let seatIndex = 0;
        for (const player of players) {
            if (player.is_host || seatIndex >= TOTAL_SEATS) continue;
            if (seatIndex === 8) seatIndex += 1;
            slots[seatIndex] = player;
            seatIndex += 1;
        }

        return slots;
    });


    let correctPlayerNickname = $derived.by(() => {
        const correctId = Object.keys(correctOverlay)[0];
        if (!correctId) return null;
        return players.find((player) => player.id === correctId)?.nickname ?? null;
    });


    let rankedPlayers = $derived.by(() => {
        return players
            .filter((p) => p.score > 0)
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                const aTime = firstCorrectAt[a.id] ?? '';
                const bTime = firstCorrectAt[b.id] ?? '';
                return aTime.localeCompare(bTime);
            });
    });


    let hintButtonLabel = $derived.by(() => {
        if (isRequestingHint) return '요청 중...';
        if (isHintVisible) return `힌트 표시됨 (${hintRequesterCount}/${hintTotalPlayers})`;
        return `힌트 보기 (${hintRequesterCount}/${hintTotalPlayers})`;
    });


    let skipButtonLabel = $derived.by(() => {
        if (isRequestingSkip) return '요청 중...';
        return `건너뛰기 (${skipRequesterCount}/${skipTotalPlayers})`;
    });


    function rankBadgeClass(position: number): string {
        if (position === 1) return 'gold';
        if (position === 2) return 'silver';
        if (position === 3) return 'bronze';
        return '';
    }


    function recordFirstCorrect(playerId: string, atIso: string) {
        if (firstCorrectAt[playerId]) return;
        firstCorrectAt = { ...firstCorrectAt, [playerId]: atIso };
    }


    function spriteStyle(characterIndex: number, gender: string): string {
        const resolvedGender = (gender === 'male' ? 'male' : 'female') as AvatarGender;
        const { sheet, x, y } = getIdleFramePosition(characterIndex, resolvedGender, 'down');
        return `background-image: url(${sheetUrl(sheet)}); background-position: -${x}px -${y}px;`;
    }


    function splitNicknameLines(nickname: string): [string, string] {
        if (nickname.length <= 8) {
            return [nickname, ''];
        }
        return [nickname.slice(0, 6), nickname.slice(6, 12)];
    }


    function showBubble(playerId: string, text: string, isCorrect: boolean) {
        bubbles = {
            ...bubbles,
            [playerId]: {
                text,
                isCorrect,
                expiresAt: Date.now() + BUBBLE_VISIBLE_MS,
                pending: false
            }
        };

        if (playerId === myPlayerId && pendingMessageText === text) {
            pendingMessageText = null;
        }
    }


    function showPendingBubble(playerId: string, text: string) {
        bubbles = {
            ...bubbles,
            [playerId]: {
                text,
                isCorrect: false,
                expiresAt: Date.now() + BUBBLE_VISIBLE_MS,
                pending: true
            }
        };
    }


    function clearMyPendingBubble(message: string) {
        if (!myPlayerId || bubbles[myPlayerId]?.text !== message || !bubbles[myPlayerId]?.pending) return;
        const next = { ...bubbles };
        delete next[myPlayerId];
        bubbles = next;
    }


    function triggerBounce(playerId: string) {
        if (bounceTimers[playerId]) clearTimeout(bounceTimers[playerId]);

        bouncingPlayerIds = { ...bouncingPlayerIds, [playerId]: true };
        bounceTimers[playerId] = setTimeout(() => {
            const next = { ...bouncingPlayerIds };
            delete next[playerId];
            bouncingPlayerIds = next;
            delete bounceTimers[playerId];
        }, BOUNCE_DURATION_MS);
    }


    function scrollChatToBottom() {
        if (chatLogRef) chatLogRef.scrollTop = chatLogRef.scrollHeight;
    }


    async function appendChatLog(entry: ChatLogEntry) {
        if (seenChatMessageIds.has(entry.id)) return;
        seenChatMessageIds.add(entry.id);

        chatLog = [...chatLog, entry].slice(-200);
        await tick();
        requestAnimationFrame(scrollChatToBottom);
    }


    async function focusAnswerInput() {
        await tick();
        if (session?.phase !== 'question' || myAlreadyCorrect || isSendingMessage) return;
        chatInputRef?.focus();
    }


    function showCorrectWrongOverlays(correctPlayerId: string | null) {
        correctOverlay = {};
        wrongOverlay = {};

        if (correctPlayerId) {
            correctOverlay[correctPlayerId] = true;
            for (const player of players) {
                if (player.id !== correctPlayerId) wrongOverlay[player.id] = true;
            }
            return;
        }

        for (const player of players) wrongOverlay[player.id] = true;
    }


    function countRequesters(requestedBy: string[] | null): number {
        if (!requestedBy || !Array.isArray(requestedBy)) return 0;
        return requestedBy.length;
    }


    function updateHintState(hintRequestedBy: string[] | null, totalPlayers?: number) {
        const requesterCount = countRequesters(hintRequestedBy);

        if (isHintVisible && requesterCount < hintRequesterCount) {
            return;
        }

        hintRequesterCount = requesterCount;

        if (totalPlayers !== undefined) {
            hintTotalPlayers = totalPlayers;
        }

        const effectiveTotal = totalPlayers !== undefined ? totalPlayers : hintTotalPlayers;

        if (
            session?.phase === 'question' &&
            currentHint &&
            effectiveTotal > 0 &&
            requesterCount >= effectiveTotal
        ) {
            isHintVisible = true;
            stopHintPolling();
        }
    }


    function updateSkipState(skipRequestedBy: string[] | null, totalPlayers?: number) {
        const requesterCount = countRequesters(skipRequestedBy);

        if (requesterCount < skipRequesterCount && hasTriggeredSkipAdvance) {
            return;
        }

        skipRequesterCount = requesterCount;

        if (totalPlayers !== undefined) {
            skipTotalPlayers = totalPlayers;
        }

        const effectiveTotal = totalPlayers !== undefined ? totalPlayers : skipTotalPlayers;

        if (
            session?.phase === 'question' &&
            effectiveTotal > 0 &&
            requesterCount >= effectiveTotal &&
            !hasTriggeredSkipAdvance
        ) {
            hasTriggeredSkipAdvance = true;
            stopSkipPolling();
            if (isHost) {
                void handleRevealAnswer();
            }
        }
    }


    function startHintPolling() {
        stopHintPolling();
        if (!room) return;

        let attempts = 0;

        const poll = async () => {
            attempts += 1;
            if (isHintVisible || attempts > HINT_POLL_MAX_ATTEMPTS || !room) {
                stopHintPolling();
                return;
            }

            const { data, error } = await supabase
                .from('rooms')
                .select('hint_requested_by')
                .eq('id', room.id)
                .single();

            if (!error && data) {
                updateHintState(data.hint_requested_by as string[] | null, players.length);
            }

            if (isHintVisible) {
                stopHintPolling();
                return;
            }

            const isWarmingUp = channelReadyAt === null || (Date.now() - channelReadyAt) < CHANNEL_WARMUP_GRACE_MS;
            const nextInterval = isWarmingUp ? 150 : HINT_POLL_INTERVAL_MS;

            hintPollTimer = setTimeout(poll, nextInterval);
        };

        const isWarmingUp = channelReadyAt === null || (Date.now() - channelReadyAt) < CHANNEL_WARMUP_GRACE_MS;
        hintPollTimer = setTimeout(poll, isWarmingUp ? 100 : HINT_POLL_INTERVAL_MS);
    }


    function stopHintPolling() {
        if (hintPollTimer) {
            clearTimeout(hintPollTimer);
            hintPollTimer = null;
        }
    }


    function startSkipPolling() {
        stopSkipPolling();
        if (!room) return;

        let attempts = 0;

        const poll = async () => {
            attempts += 1;
            if (hasTriggeredSkipAdvance || attempts > HINT_POLL_MAX_ATTEMPTS || !room) {
                stopSkipPolling();
                return;
            }

            const { data, error } = await supabase
                .from('rooms')
                .select('skip_requested_by')
                .eq('id', room.id)
                .single();

            if (!error && data) {
                updateSkipState(data.skip_requested_by as string[] | null, players.length);
            }

            if (hasTriggeredSkipAdvance) {
                stopSkipPolling();
                return;
            }

            const isWarmingUp = channelReadyAt === null || (Date.now() - channelReadyAt) < CHANNEL_WARMUP_GRACE_MS;
            const nextInterval = isWarmingUp ? 150 : HINT_POLL_INTERVAL_MS;

            skipPollTimer = setTimeout(poll, nextInterval);
        };

        const isWarmingUp = channelReadyAt === null || (Date.now() - channelReadyAt) < CHANNEL_WARMUP_GRACE_MS;
        skipPollTimer = setTimeout(poll, isWarmingUp ? 100 : HINT_POLL_INTERVAL_MS);
    }


    function stopSkipPolling() {
        if (skipPollTimer) {
            clearTimeout(skipPollTimer);
            skipPollTimer = null;
        }
    }


    async function loadQuestionContext(questionId: string | null, phase: string) {
        if (questionId !== previousQuestionId) {
            isHintVisible = false;
            hintRequesterCount = 0;
            hintTotalPlayers = 0;
            isRequestingHint = false;
            stopHintPolling();

            skipRequesterCount = 0;
            skipTotalPlayers = 0;
            isRequestingSkip = false;
            hasTriggeredSkipAdvance = false;
            stopSkipPolling();
        }
        
        if (!questionId) {
            currentPrompt = null;
            currentCorrectAnswers = null;
            currentHint = null;
            isHintVisible = false;
            isRequestingHint = false;
            hintRequesterCount = 0;
            hintTotalPlayers = 0;
            return;
        }

        if (phase === 'reveal') {
            const { data } = await supabase
                .from('questions')
                .select('prompt, correct_answers, hint')
                .eq('id', questionId)
                .single();

            if (data) {
                currentPrompt = data.prompt as string;
                currentCorrectAnswers = data.correct_answers as string[];
                currentHint = (data.hint as string | null) ?? null;
            }

            isRequestingHint = false;
            hintRequesterCount = 0;
            hintTotalPlayers = 0;
            stopHintPolling();
            stopSkipPolling();
            return;
        }

        const { data } = await supabase
            .from('questions_public')
            .select('prompt, display_hint')
            .eq('id', questionId)
            .single();

        if (data) {
            currentPrompt = data.prompt as string;
            currentCorrectAnswers = null;
            currentHint = data.display_hint as string | null;
            isHintVisible = false;
            isRequestingHint = false;
            hintRequesterCount = 0;
            hintTotalPlayers = 0;
        }

        bubbles = {};
        pendingMessageText = null;
        correctOverlay = {};
        wrongOverlay = {};
    }


    async function loadInitialData() {
        isLoading = true;
        loadError = null;

        try {
            const { data: roomData, error: roomError } = await supabase
                .from('rooms')
                .select('*')
                .eq('code', roomCode)
                .single();

            if (roomError || !roomData) {
                goto('/');
                return;
            }
            room = roomData as RoomRow;

            if (room.status === 'finished') {
                goto(`/room/${roomCode}/result`);
                return;
            }
            if (room.status === 'waiting') {
                goto(`/room/${roomCode}`);
                return;
            }

            const { data: playerData, error: playerError } = await supabase
                .from('players')
                .select('*')
                .eq('room_id', room.id);

            if (playerError) throw playerError;
            players = (playerData ?? []) as PlayerRow[];

            updateHintState(roomData.hint_requested_by as string[] | null, players.length);
            updateSkipState(roomData.skip_requested_by as string[] | null, players.length);

            const storedPlayerId = getRoomPlayerId(roomCode);
            let resolvedPlayerId = storedPlayerId && players.some((player) => player.id === storedPlayerId)
                ? storedPlayerId
                : null;

            if (!resolvedPlayerId) {
                const {
                    data: { user }
                } = await supabase.auth.getUser();

                const recoveredPlayer = user
                    ? players.find((player) => player.auth_user_id === user.id)
                    : null;

                if (recoveredPlayer) {
                    resolvedPlayerId = recoveredPlayer.id;
                    saveRoomPlayerId(roomCode, recoveredPlayer.id);
                }
            }

            myPlayerId = resolvedPlayerId;

            if (!myPlayerId) {
                goto(`/room/${roomCode}/join`);
                return;
            }

            const { data: sessionData } = await supabase
                .from('game_sessions')
                .select('*')
                .eq('room_id', room.id)
                .order('question_started_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            session = (sessionData ?? null) as GameSessionRow | null;
            if (session) {
                previousQuestionId = session.question_id;
                await loadQuestionContext(session.question_id, session.phase);
                updateHintState(roomData.hint_requested_by as string[] | null, players.length);
                updateSkipState(roomData.skip_requested_by as string[] | null, players.length);
            }

            try {
                await syncServerClock();
                isClockSynced = true;
            } catch (err) {
                clockSyncError = toErrorMessage(err);
            }

            channel = subscribeToRoom(room.id, {
                onRoomChange: (row) => {
                    if (channelReadyAt === null) channelReadyAt = Date.now();
                    room = row;
                    
                    if (row.hint_requested_by !== undefined) {
                        updateHintState(row.hint_requested_by as string[] | null, players.length);
                    }
                    if (row.skip_requested_by !== undefined) {
                        updateSkipState(row.skip_requested_by as string[] | null, players.length);
                    }
                    
                    if (row.status === 'finished') {
                        goto(`/room/${roomCode}/result`);
                    } else if (row.status === 'waiting') {
                        goto(`/room/${roomCode}`);
                    }
                },
                onGameSessionChange: async (row) => {
                    if (channelReadyAt === null) channelReadyAt = Date.now();
                    const phaseChanged = session?.id !== row.id || session?.phase !== row.phase;
                    session = row;

                    if (phaseChanged) {
                        if (row.question_id !== previousQuestionId) {
                            await supabase
                                .from('rooms')
                                .update({ hint_requested_by: [], skip_requested_by: [] })
                                .eq('id', room.id);
                            
                            isHintVisible = false;
                            hintRequesterCount = 0;
                            hintTotalPlayers = players.length;
                            isRequestingHint = false;
                            stopHintPolling();

                            skipRequesterCount = 0;
                            skipTotalPlayers = players.length;
                            isRequestingSkip = false;
                            hasTriggeredSkipAdvance = false;
                            stopSkipPolling();

                            previousQuestionId = row.question_id;
                        }
                        
                        await loadQuestionContext(row.question_id, row.phase);
                        hintTotalPlayers = players.length;
                        skipTotalPlayers = players.length;
                        
                        chatInput = '';
                        pendingMessageText = null;
                        await tick();
                        requestAnimationFrame(scrollChatToBottom);
                        if (row.phase === 'question') await focusAnswerInput();
                    }
                },
                onPlayerChange: (row, eventType, oldRow) => {
                    if (channelReadyAt === null) channelReadyAt = Date.now();
                    if (eventType === 'DELETE') {
                        const removedId = oldRow?.id ?? row?.id;
                        if (removedId) {
                            players = players.filter((player) => player.id !== removedId);
                        }
                        hintTotalPlayers = players.length;
                        skipTotalPlayers = players.length;
                        return;
                    }

                    if (!row) return;

                    const index = players.findIndex((player) => player.id === row.id);
                    if (index === -1) {
                        players = [...players, row];
                    } else {
                        const next = [...players];
                        next[index] = row;
                        players = next;
                    }
                    hintTotalPlayers = players.length;
                    skipTotalPlayers = players.length;
                },
                onChatMessage: (row: ChatMessageRow) => {
                    if (channelReadyAt === null) channelReadyAt = Date.now();
                    showBubble(row.player_id, row.message, row.is_correct_answer);
                    triggerBounce(row.player_id);

                    if (row.player_id !== myPlayerId) {
                        const nickname = players.find((p) => p.id === row.player_id)?.nickname ?? '???';
                        void appendChatLog({
                            id: row.id,
                            nickname,
                            message: row.message,
                            isCorrect: row.is_correct_answer
                        });
                    }

                    if (
                        row.is_correct_answer &&
                        session?.phase === 'question' &&
                        row.question_id === session.question_id
                    ) {
                        showCorrectWrongOverlays(row.player_id);
                        recordFirstCorrect(row.player_id, row.created_at);

                        if (isHost) void handleRevealAnswer();
                    }
                }
            });

            const { data: latestRoomData, error: latestRoomError } = await supabase
                .from('rooms')
                .select('*')
                .eq('id', room.id)
                .single();

            if (!latestRoomError && latestRoomData) {
                if (latestRoomData.status === 'finished') {
                    if (channel) unsubscribeFromRoom(channel);
                    goto(`/room/${roomCode}/result`);
                    return;
                }
                if (latestRoomData.status === 'waiting') {
                    if (channel) unsubscribeFromRoom(channel);
                    goto(`/room/${roomCode}`);
                    return;
                }
                room = latestRoomData as RoomRow;
                updateHintState(latestRoomData.hint_requested_by as string[] | null, players.length);
                updateSkipState(latestRoomData.skip_requested_by as string[] | null, players.length);
            }

            presenceHandle = joinRoomPresence(room.id, myPlayerId, () => room?.host_id ?? null);

            tickTimer = setInterval(() => {
                nowTick = Date.now();
                const now = Date.now();
                const next: Record<string, BubbleState> = {};

                for (const [playerId, bubble] of Object.entries(bubbles)) {
                    if (bubble.expiresAt > now) next[playerId] = bubble;
                }

                bubbles = next;
            }, 250);
        } catch (err) {
            loadError = toErrorMessage(err);
        } finally {
            isLoading = false;
            if (session?.phase === 'question') await focusAnswerInput();
        }
    }


    async function handleSendMessage(event: SubmitEvent) {
        event.preventDefault();
        if (myAlreadyCorrect) return;

        const text = chatInput.trim();
        if (!text || !room || !myPlayerId || isSendingMessage) return;

        isSendingMessage = true;
        actionError = null;
        const originalInput = chatInput;

        pendingMessageText = text;
        showPendingBubble(myPlayerId, text);
        triggerBounce(myPlayerId);
        chatInput = '';

        try {
            const { data, error } = await supabase.rpc('send_message', {
                p_room_id: room.id,
                p_message: text
            });

            if (error) throw error;

            const result = (Array.isArray(data) ? data[0] : data) as SendMessageResult | null;
            const isCorrect = result?.is_correct === true;

            if (session?.phase === 'question') {
                showBubble(myPlayerId, text, isCorrect);
            }

            const nickname = myPlayer?.nickname ?? '???';
            void appendChatLog({
                id: `local-${myPlayerId}-${Date.now()}`,
                nickname,
                message: text,
                isCorrect
            });

            if (isCorrect && session?.phase === 'question') {
                showCorrectWrongOverlays(myPlayerId);
                recordFirstCorrect(myPlayerId, new Date().toISOString());
            }
        } catch (err) {
            clearMyPendingBubble(text);
            pendingMessageText = null;
            chatInput = originalInput;
            actionError = toErrorMessage(err);
        } finally {
            isSendingMessage = false;
            await focusAnswerInput();
        }
    }


    async function toggleHint() {
        if (!room || !myPlayerId || session?.phase !== 'question' || isRequestingHint) return;
        
        isRequestingHint = true;
        
        try {
            const { data, error } = await supabase.rpc('request_hint', {
                p_room_id: room.id,
                p_player_id: myPlayerId
            });
            
            if (error) throw error;
            
            const result = data as { 
                all_requested: boolean; 
                hint_requested_by: string[];
                total_players: number;
                requester_count: number;
            };
            
            updateHintState(result.hint_requested_by, result.total_players);

            if (!result.all_requested) {
                startHintPolling();
            }
        } catch (err) {
            actionError = toErrorMessage(err);
        } finally {
            isRequestingHint = false;
        }
    }


    async function toggleSkip() {
        if (!room || !myPlayerId || session?.phase !== 'question' || isRequestingSkip || hasTriggeredSkipAdvance) return;

        isRequestingSkip = true;

        try {
            const { data, error } = await supabase.rpc('request_skip', {
                p_room_id: room.id,
                p_player_id: myPlayerId
            });

            if (error) throw error;

            const result = data as {
                all_requested: boolean;
                skip_requested_by: string[];
                total_players: number;
                requester_count: number;
            };

            updateSkipState(result.skip_requested_by, result.total_players);

            if (!result.all_requested) {
                startSkipPolling();
            }
        } catch (err) {
            actionError = toErrorMessage(err);
        } finally {
            isRequestingSkip = false;
        }
    }


    /**
     * 방 나가기: 실제로 DB 에서 내 players 행을 제거하는 RPC 를 먼저 호출한 뒤 이동한다.
     * - 방장이면 cancel_room: 남은 인원이 있으면 위임, 없으면(=혼자였던 경우) 방까지 즉시 삭제
     * - 참가자면 leave_room: 내 players 행만 삭제. 이후 방에 아무도 안 남으면
     *   players 테이블의 DELETE 트리거(cleanup_room_if_empty)가 즉시 방을 정리한다.
     * 이 RPC 호출이 없으면 players 행이 그대로 남아 트리거가 발동하지 않고,
     * 좀비 방 안전망(cron, 최대 1분+120초 유예)에서야 뒤늦게 정리되어 버린다.
     */
    async function handleLeaveRoom() {
        if (!confirm('정말로 방을 나가시겠습니까?')) return;
        if (!room || !myPlayerId || isLeavingRoom) return;

        isLeavingRoom = true;
        actionError = null;

        try {
            if (isHost) {
                const { error } = await supabase.rpc('cancel_room', { p_room_id: room.id });
                if (error) throw error;
            } else {
                const { error } = await supabase.rpc('leave_room', { p_room_id: room.id });
                if (error) throw error;
            }
        } catch (err) {
            console.error('[play] handleLeaveRoom RPC 실패:', err);
            // RPC 가 실패해도 사용자는 방을 나가고 싶어했으므로 이동은 계속 진행한다.
            // (남은 좀비 방 정리는 안전망 cron 이 처리한다)
        } finally {
            isLeavingRoom = false;
            goto('/');
        }
    }


    async function handleRevealAnswer() {
        if (!room || !session || isRevealing) return;
        if (session.phase !== 'question') return;
        if (revealedForSessionId === session.id) return;

        const sessionId = session.id;
        revealedForSessionId = sessionId;
        isRevealing = true;
        actionError = null;

        try {
            const { error } = await supabase.rpc('reveal_answer', {
                p_room_id: room.id
            });

            if (!error) return;

            console.error('[play] reveal_answer RPC 실패', {
                roomId: room.id,
                roomCode,
                sessionId,
                sessionPhase: session.phase,
                currentRound: room.current_round,
                totalRounds: room.total_rounds,
                myPlayerId,
                isHost,
                errorCode: error.code,
                errorMessage: error.message,
                errorDetails: error.details,
                errorHint: error.hint
            });

            const message = toErrorMessage(error);

            if (message.includes('NOT_HOST')) {
                actionError = '방장 권한 상태가 변경되었습니다. 대기실로 이동합니다.';
                setTimeout(() => goto(`/room/${roomCode}`), 1200);
                return;
            }

            if (message.includes('ROOM_NOT_FOUND')) {
                actionError = '방이 종료되었거나 존재하지 않습니다.';
                setTimeout(() => goto('/'), 1200);
                return;
            }

            if (
                message.includes('NO_ACTIVE_QUESTION_PHASE') ||
                message.includes('ANSWER_ALREADY_REVEALED')
            ) {
                return;
            }

            actionError = message;
            revealedForSessionId = null;
        } catch (err) {
            actionError = toErrorMessage(err);
        } finally {
            isRevealing = false;
        }
    }


    async function handleAdvanceOrFinish() {
        if (!room || !session || isAdvancing) return;
        if (session.phase !== 'reveal') return;
        if (advancedForSessionId === session.id) return;

        const sessionId = session.id;
        advancedForSessionId = sessionId;
        isAdvancing = true;
        actionError = null;

        try {
            if (room.current_round >= room.total_rounds) {
                const { error } = await supabase.rpc('end_game', { p_room_id: room.id });

                if (error) {
                    const message = toErrorMessage(error);
                    if (
                        message.includes('GAME_ALREADY_FINISHED') ||
                        message.includes('ROOM_NOT_PLAYING') ||
                        message.includes('NOT_HOST')
                    ) {
                        return;
                    }
                    throw error;
                }

                goto(`/room/${roomCode}/result`);
                return;
            }

            const { error } = await supabase.rpc('start_round', { p_room_id: room.id });
            if (!error) return;

            const message = toErrorMessage(error);
            if (
                message.includes('ROUND_ALREADY_STARTED') ||
                message.includes('NO_ACTIVE_REVEAL_PHASE') ||
                message.includes('ALL_ROUNDS_COMPLETED') ||
                message.includes('NOT_HOST')
            ) {
                return;
            }

            throw error;
        } catch (err) {
            actionError = toErrorMessage(err);
            advancedForSessionId = null;
        } finally {
            isAdvancing = false;
        }
    }


    function handlePageHide() {
        if (!room || !myPlayerId) return;

        const rpcName = isHost ? 'cancel_room' : 'leave_room';

        const cachedSession = JSON.parse(
            localStorage.getItem(
                `sb-${new URL(supabase.supabaseUrl).hostname.split('.')[0]}-auth-token`
            ) ?? 'null'
        );
        const accessToken = cachedSession?.access_token;
        if (!accessToken) return;

        const url = `${supabase.supabaseUrl}/rest/v1/rpc/${rpcName}`;
        const body = JSON.stringify({ p_room_id: room.id });

        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    }


    $effect(() => {
        if (!isClockSynced || !isHost || !session) return;
        if (session.phase !== 'question' || remainingSeconds > 0) return;
        if (isRevealing || revealedForSessionId === session.id) return;
        void handleRevealAnswer();
    });


    $effect(() => {
        if (!isClockSynced || !isHost || !session) return;
        if (session.phase !== 'reveal' || remainingSeconds > 0) return;
        if (isAdvancing || advancedForSessionId === session.id) return;
        void handleAdvanceOrFinish();
    });


    onMount(() => {
        void loadInitialData();

        if (chatLogRef) {
            chatLogResizeObserver = new ResizeObserver(() => {
                scrollChatToBottom();
            });
            chatLogResizeObserver.observe(chatLogRef);
        }
    });


    onDestroy(() => {
        if (channel) unsubscribeFromRoom(channel);
        if (presenceHandle) presenceHandle.stop();
        if (tickTimer) clearInterval(tickTimer);
        stopHintPolling();
        stopSkipPolling();
        if (chatLogResizeObserver) chatLogResizeObserver.disconnect();
        for (const timer of Object.values(bounceTimers)) clearTimeout(timer);
    });
</script>


<div class="play-page">
    <div class="realtime-ranking-widget">
        <div class="ranking-widget-header">
            <span class="trophy-icon">🏆</span>
            <span class="ranking-widget-title">실시간 순위</span>
        </div>

        <ul class="ranking-widget-list">
            {#if rankedPlayers.length === 0}
                <li class="ranking-widget-empty">아직 정답자가 없습니다</li>
            {:else}
                {#each rankedPlayers as p, idx (p.id)}
                    <li class="ranking-widget-item {p.id === myPlayerId ? 'me' : ''}">
                        <span class="rank-badge {rankBadgeClass(idx + 1)}">{idx + 1}위</span>
                        <span class="player-name-widget">{p.nickname}</span>
                        <span class="score-badge">{p.score}점</span>
                    </li>
                {/each}
            {/if}
        </ul>
    </div>

    {#if isLoading}
        <p class="status-text text-center">게임 정보를 불러오는 중...</p>
    {:else if loadError}
        <p class="status-text error text-center">{loadError}</p>
    {:else if room && session}
        <div class="stage-shell">
            <header class="stage-header">
                <span class="stage-header-spacer" aria-hidden="true"></span>

                <span class="stage-header-meta">
                    <span class="round-badge">{room.current_round} / {room.total_rounds} 라운드</span>
                    <span class="timer-badge">{remainingSeconds}초</span>
                </span>

                <button
                    type="button"
                    class="leave-room-button"
                    onclick={handleLeaveRoom}
                    disabled={isLeavingRoom}
                >
                    {isLeavingRoom ? '나가는 중...' : '방 나가기'}
                </button>
            </header>

            {#if clockSyncError || actionError}
                <p class="status-text error compact text-center">{actionError ?? clockSyncError}</p>
            {/if}

            <div class="prompt-board">
                <div class="prompt-heading-row">
                    {#if session.phase === 'question' && currentHint}
                        <button
                            type="button"
                            class="hint-toggle-button"
                            onclick={toggleHint}
                            aria-expanded={isHintVisible}
                            disabled={isRequestingHint || isHintVisible}
                        >
                            {hintButtonLabel}
                        </button>
                    {:else}
                        <span class="hint-toggle-spacer" aria-hidden="true"></span>
                    {/if}

                    <span class="prompt-label">[{session.phase === 'question' ? '문제' : '정답 공개'}]</span>

                    {#if session.phase === 'question'}
                        <button
                            type="button"
                            class="skip-round-button"
                            onclick={toggleSkip}
                            disabled={isRequestingSkip || hasTriggeredSkipAdvance}
                        >
                            {skipButtonLabel}
                        </button>
                    {:else}
                        <span class="prompt-heading-spacer" aria-hidden="true"></span>
                    {/if}
                </div>

                <p class="prompt-text">{currentPrompt ?? '문제를 불러오는 중...'}</p>

                {#if session.phase === 'question' && isHintVisible && currentHint}
                    <div class="hint-display-box show">
                        <div class="hint-box-header">
                            <span class="hint-box-icon">💡</span>
                            <span>힌트</span>
                        </div>
                        <div class="hint-box-content">{currentHint}</div>
                    </div>
                {/if}

                {#if session.phase === 'reveal' && currentCorrectAnswers}
                    <p class="answer-reveal-list">정답: {currentCorrectAnswers.join(', ')}</p>
                {/if}
            </div>

            <div class="seat-stage-wrap">
                {#if Object.keys(correctOverlay).length > 0 && correctPlayerNickname}
                    <div class="correct-player-banner">{correctPlayerNickname}님이 정답을 맞혔습니다!</div>
                {/if}

                <div class="seat-stage">
                    {#each seats as seatPlayer, seatIndex (seatIndex)}
                        <div class="seat">
                            {#if seatPlayer}
                                <div class="seat-booth {seatPlayer.id === myPlayerId ? 'me' : ''}">
                                    {#if bubbles[seatPlayer.id]}
                                        <div class="speech-bubble {bubbles[seatPlayer.id].isCorrect ? 'correct' : ''} {bubbles[seatPlayer.id].pending ? 'pending' : ''}">
                                            {bubbles[seatPlayer.id].text}
                                        </div>
                                    {/if}

                                    {#if correctOverlay[seatPlayer.id]}
                                        <div class="seat-overlay correct">O</div>
                                    {:else if wrongOverlay[seatPlayer.id]}
                                        <div class="seat-overlay wrong">X</div>
                                    {/if}

                                    <div class="seat-avatar-wrap {bouncingPlayerIds[seatPlayer.id] ? 'bounce' : ''}">
                                        <span
                                            class="seat-avatar"
                                            style={`width: ${FRAME_WIDTH}px; height: ${FRAME_HEIGHT}px; ${spriteStyle(seatPlayer.character_index, seatPlayer.avatar_gender)}`}
                                            aria-hidden="true"
                                        ></span>
                                    </div>

                                    <span class="seat-nickname-lines">
                                        <span class="seat-nickname-line">{splitNicknameLines(seatPlayer.nickname)[0]}</span>
                                        <span class="seat-nickname-line">{splitNicknameLines(seatPlayer.nickname)[1]}</span>
                                    </span>

                                    <div class="seat-bottom-row">
                                        {#if seatPlayer.is_host}
                                            <span class="seat-host-tag">방장</span>
                                        {/if}
                                        <span class="seat-score">{seatPlayer.score}점</span>
                                    </div>
                                </div>
                            {:else}
                                <div class="seat-booth empty"></div>
                            {/if}
                        </div>
                    {/each}
                </div>
            </div>

            <footer class="stage-footer">
                <div class="chat-log" bind:this={chatLogRef}>
                    {#each chatLog as entry (entry.id)}
                        <p class="chat-log-line {entry.isCorrect ? 'correct' : ''}">
                            <span class="chat-log-nickname">[{entry.nickname}]</span>
                            {entry.message}
                        </p>
                    {/each}
                </div>

                {#if session.phase === 'question' && myAlreadyCorrect}
                    <p class="correct-notice text-center">정답을 맞히셨습니다! 곧 다음 문제로 넘어갑니다.</p>
                {:else if session.phase !== 'question'}
                    <p class="status-text compact text-center">
                        {remainingSeconds}초 후 {room.current_round >= room.total_rounds ? '결과 화면으로 이동합니다' : '다음 라운드가 시작됩니다'}.
                    </p>
                {:else}
                    <form class="answer-form" onsubmit={handleSendMessage}>
                        <input
                            class="input"
                            type="text"
                            placeholder="채팅으로 정답을 입력하세요"
                            bind:value={chatInput}
                            bind:this={chatInputRef}
                            maxlength={CHAT_MAX_LENGTH}
                            disabled={isSendingMessage || remainingSeconds === 0 || myAlreadyCorrect}
                        />
                        <button type="submit" class="btn btn-primary" disabled={isSendingMessage || remainingSeconds === 0 || myAlreadyCorrect}>
                            전송
                        </button>
                    </form>
                {/if}
            </footer>
        </div>
    {:else if room}
        <p class="status-text text-center">라운드를 준비하는 중입니다...</p>
    {/if}
</div>


<style>
    .play-page {
        display: flex;
        align-items: flex-start;
        justify-content: center;
        box-sizing: border-box;
        height: calc(100dvh - (var(--page-padding-y) * 2));
        min-height: 0;
        padding: 0;
        overflow: hidden;
    }

    .realtime-ranking-widget {
        position: fixed;
        top: 92px;
        left: 24px;
        z-index: 200;
        display: flex;
        width: 270px;
        flex-direction: column;
        box-sizing: border-box;
        overflow: hidden;
        border: 2px solid var(--color-border);
        border-radius: 12px;
        background: var(--color-surface-darker);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }

    .ranking-widget-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 10px 14px;
        border-bottom: 2px solid var(--color-border);
        background: var(--color-surface-dark);
    }

    .trophy-icon {
        font-size: 16px;
    }

    .ranking-widget-title {
        color: var(--color-text-primary);
        font-size: 13px;
        font-weight: 900;
    }

    .ranking-widget-list {
        display: flex;
        flex-direction: column;
        gap: 0;
        margin: 0;
        padding: 6px;
        list-style: none;
    }

    .ranking-widget-empty {
        padding: 10px 8px;
        color: var(--color-text-muted);
        font-size: 12px;
        text-align: center;
    }

    .ranking-widget-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 6px;
    }

    .ranking-widget-item.me {
        background: rgba(255, 213, 74, 0.16);
    }

    .rank-badge {
        flex: 0 0 auto;
        padding: 2px 7px;
        border-radius: 6px;
        background: var(--color-surface-dark);
        color: var(--color-text-secondary);
        font-size: 11px;
        font-weight: 900;
        white-space: nowrap;
    }

    .rank-badge.gold {
        background: #ffd54a;
        color: #5a3d00;
    }

    .rank-badge.silver {
        background: #d8dce6;
        color: #3a3f4a;
    }

    .rank-badge.bronze {
        background: #d99a5b;
        color: #4a2c0c;
    }

    .player-name-widget {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        color: var(--color-text-primary);
        font-size: 13px;
        font-weight: 700;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .score-badge {
        flex: 0 0 auto;
        color: var(--color-accent);
        font-size: 13px;
        font-weight: 900;
        white-space: nowrap;
    }

    @media (max-width: 1400px) {
        .realtime-ranking-widget {
            display: none;
        }
    }

    .stage-shell {
        display: flex;
        flex-direction: column;
        gap: 12px;
        width: 100%;
        max-width: 1280px;
        height: min(864px, 100%);
        max-height: 100%;
        min-height: 0;
        margin-top: 0;
        margin-bottom: auto;
    }

    .status-text {
        padding: 2rem 0;
        color: #eaf6ff;
    }

    .status-text.compact {
        margin: 0;
        padding: 4px 0;
        font-size: 14px;
    }

    .status-text.error {
        color: var(--color-error);
    }

    .stage-header {
        display: grid;
        flex: 0 0 40px;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 8px;
    }

    .stage-header-meta {
        grid-column: 2;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
    }

    .stage-header-spacer {
        grid-column: 1;
        width: 1px;
    }

    .round-badge,
    .timer-badge {
        padding: 6px 14px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 800;
        white-space: nowrap;
    }

    .round-badge {
        background: #1c4a73;
        color: #eaf6ff;
    }

    .timer-badge {
        background: var(--color-accent);
        color: var(--color-accent-text);
    }

    .prompt-board {
        display: flex;
        flex: 0 0 auto;
        min-height: 140px;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 16px 24px;
        box-sizing: border-box;
        border: 3px solid #8fd0f0;
        border-radius: 10px;
        background: #ffffff;
        box-shadow: inset 0 0 0 2px #cdeaf9;
        text-align: center;
    }

    .prompt-heading-row {
        display: grid;
        width: 100%;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 12px;
    }

    .prompt-label {
        grid-column: 2;
        display: inline-block;
        color: #1c4a73;
        font-size: 16px;
        font-weight: 900;
        line-height: 1;
        text-align: center;
        white-space: nowrap;
        vertical-align: baseline;
    }

    .hint-toggle-button {
        grid-column: 1;
        justify-self: start;
        flex: 0 0 auto;
        padding: 6px 10px;
        border: 1px solid #f6c344;
        border-radius: 999px;
        background: #fff8df;
        color: #8a5b00;
        font: inherit;
        font-size: 13px;
        font-weight: 700;
        line-height: 1.2;
        white-space: nowrap;
        cursor: pointer;
    }

    .skip-round-button {
        grid-column: 3;
        justify-self: end;
        flex: 0 0 auto;
        padding: 6px 10px;
        border: 1px solid #6ba8e0;
        border-radius: 999px;
        background: #eaf4ff;
        color: #1c4a73;
        font: inherit;
        font-size: 13px;
        font-weight: 700;
        line-height: 1.2;
        white-space: nowrap;
        cursor: pointer;
    }

    .skip-round-button:hover {
        background: #d8ebff;
    }

    .skip-round-button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }

    .leave-room-button {
        justify-self: end;
        flex: 0 0 auto;
        padding: 6px 14px;
        border: none;
        border-radius: 8px;
        background: #1c4a73;
        color: #eaf6ff;
        font: inherit;
        font-size: 14px;
        font-weight: 800;
        white-space: nowrap;
        cursor: pointer;
    }

    .leave-room-button:hover {
        background: #245a8c;
    }

    .leave-room-button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }

    .hint-toggle-spacer,
    .prompt-heading-spacer {
        grid-column: 1;
        width: 1px;
    }

    .prompt-heading-spacer {
        grid-column: 3;
    }

    .hint-toggle-button:hover {
        background: #ffefb0;
    }

    .hint-toggle-button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }

    /* 힌트 표시 박스 - 사용자 지정 스타일 */
    .hint-display-box {
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        width: 60%;
        margin: 12px 0 0;
        padding: 12px 14px;
        border: 2px solid rgb(171, 71, 188);
        border-radius: 12px;
        background: linear-gradient(135deg, rgb(255, 248, 225) 0%, rgb(255, 243, 196) 100%);
        box-shadow: rgba(171, 71, 188, 0.2) 0px 4px 12px;
    }

    .hint-box-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 6px;
        color: rgb(171, 71, 188);
        font-size: 13px;
        font-weight: 800;
    }

    .hint-box-icon {
        font-size: 14px;
        line-height: 1;
    }

    .hint-box-content {
        color: #6f4b00;
        font-size: 22px;
        font-weight: 800;
        letter-spacing: 4px;
        line-height: 1;
        text-align: center;
    }

    .prompt-text {
        display: -webkit-box;
        width: 94%;
        max-width: 94%;
        margin: 0;
        overflow: hidden;
        color: #1a1a1a;
        font-size: 28px;
        font-weight: 800;
        line-height: 1.35;
        text-align: center;
        overflow-wrap: break-word;
        word-break: keep-all;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
    }

    .answer-reveal-list {
        margin: 2px 0 0;
        color: #1c7a4a;
        font-size: 18px;
        font-weight: 900;
    }

    .seat-stage-wrap {
        position: relative;
        display: flex;
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.08);
    }

    .seat-stage {
        display: grid;
        width: 100%;
        box-sizing: border-box;
        grid-template-columns: repeat(8, 1fr);
        align-content: end;
        justify-content: center;
        row-gap: 62px;
        column-gap: 8px;
        padding: 88px 12px 12px;
    }

    .seat {
        width: 100%;
        max-width: 132px;
        min-width: 0;
        margin: 0 auto;
    }

    .seat-booth {
        position: relative;
        display: flex;
        width: 100%;
        height: 132px;
        box-sizing: border-box;
        flex-direction: column;
        align-items: center;
        justify-content: flex-end;
        gap: 4px;
        padding: 6px 4px 8px;
        overflow: visible;
        border-radius: 12px;
        background: linear-gradient(180deg, #7fd0ec 0%, #4aa8d8 60%, #2f6fa8 100%);
        box-shadow: inset 0 -3px 0 rgba(0, 0, 0, 0.15), 0 2px 4px rgba(0, 0, 0, 0.2);
    }

    .seat-booth.empty {
        background: rgba(255, 255, 255, 0.12);
        box-shadow: none;
    }

    .seat-booth.me {
        box-shadow: 0 0 0 2px var(--color-accent), inset 0 -3px 0 rgba(0, 0, 0, 0.15);
    }

    .speech-bubble {
        position: absolute;
        bottom: calc(100% + 6px);
        left: 50%;
        z-index: 5;
        display: -webkit-box;
        width: 118px;
        max-height: 74px;
        box-sizing: border-box;
        padding: 6px 9px;
        overflow: hidden;
        border-radius: 8px;
        transform: translateX(-50%);
        background: #fff;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
        color: #1a1440;
        font-size: 13px;
        font-weight: 800;
        line-height: 1.25;
        text-align: center;
        white-space: normal;
        word-break: break-all;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
    }

    .speech-bubble::after {
        position: absolute;
        top: 100%;
        left: 50%;
        content: '';
        transform: translateX(-50%);
        border-width: 6px 6px 0;
        border-style: solid;
        border-color: #fff transparent transparent;
    }

    .speech-bubble.correct {
        background: #a7f0c4;
        color: #1a4a2e;
    }

    .speech-bubble.correct::after {
        border-color: #a7f0c4 transparent transparent;
    }

    .speech-bubble.pending {
        opacity: 0.86;
    }

    .seat-overlay {
        position: absolute;
        top: 30%;
        left: 50%;
        z-index: 6;
        transform: translate(-50%, -50%);
        color: #35e07a;
        font-size: 70px;
        font-weight: 900;
        line-height: 1;
        pointer-events: none;
        animation: seat-overlay-pop 0.5s ease-out forwards;
    }

    .seat-overlay.correct {
        color: #5d35e0e6;
        text-shadow: 0 0 10px rgba(93, 53, 224, 0.9);
    }

    .seat-overlay.wrong {
        color: #fc324ae6;
        text-shadow: 0 0 10px rgba(252, 50, 74, 0.9);
    }

    @keyframes seat-overlay-pop {
        0% { opacity: 0; transform: translate(-50%, -50%) scale(0.4); }
        60% { opacity: 1; transform: translate(-50%, -50%) scale(1.2); }
        100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }

    .seat-avatar-wrap {
        display: flex;
        width: 100%;
        min-height: 0;
        flex: 1 1 auto;
        align-items: flex-end;
        justify-content: center;
        overflow: visible;
        padding-bottom: 1px;
    }

    .seat-avatar {
        flex-shrink: 0;
        background-repeat: no-repeat;
        image-rendering: pixelated;
        transform: scale(0.9);
        transform-origin: bottom center;
    }

    .seat-avatar-wrap.bounce {
        animation: bounce-up 0.5s ease-out;
    }

    @keyframes bounce-up {
        0% { transform: translateY(0); }
        30% { transform: translateY(-8px); }
        55% { transform: translateY(0); }
        75% { transform: translateY(-3px); }
        100% { transform: translateY(0); }
    }

    .seat-nickname-badge {
        display: flex;
        max-width: 100%;
        padding: 2px 5px;
        overflow: hidden;
        border-radius: 5px;
        flex: 0 0 auto;
        align-items: center;
        gap: 3px;
        background: rgba(10, 30, 50, 0.72);
    }

    .seat-nickname-lines {
        display: flex;
        flex: 0 0 auto;
        flex-direction: column;
        align-items: center;
        gap: 1px;
        margin-top: 2px;
        line-height: 1.15;
    }

    .seat-nickname-line {
        display: block;
        min-height: 1em;
        max-width: 100%;
        overflow: hidden;
        color: #fff;
        font-size: 12px;
        font-weight: 800;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .seat-nickname-line:empty {
        min-height: 0;
    }

    .seat-bottom-row {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: center;
        gap: 5px;
        margin-top: 3px;
    }

    .seat-nickname {
        display: -webkit-box;
        width: 100%;
        max-width: 100%;
        overflow: hidden;
        color: #fff;
        font-size: 11px;
        font-weight: 800;
        line-height: 1.2;
        text-align: center;
        word-break: break-all;
        white-space: normal;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
    }

    .seat-host-tag {
        padding: 2px 4px;
        border-radius: 4px;
        flex: 0 0 auto;
        background: var(--color-accent);
        color: var(--color-accent-text);
        font-size: 9px;
        font-weight: 900;
        white-space: nowrap;
    }

    .seat-score {
        color: #ffe9a8;
        font-size: 13px;
        font-weight: 800;
        flex: 0 0 auto;
    }

    .correct-player-banner {
        position: absolute;
        top: 32px;
        left: 50%;
        z-index: 7;
        max-width: calc(100% - 32px);
        padding: 6px 16px;
        overflow: hidden;
        border-radius: 8px;
        transform: translateX(-50%);
        background: rgba(167, 240, 196, 0.95);
        box-shadow: 0 3px 8px rgba(0, 0, 0, 0.25);
        color: #1a4a2e;
        font-size: 16px;
        font-weight: 900;
        text-align: center;
        text-overflow: ellipsis;
        white-space: nowrap;
        animation: seat-overlay-pop 0.4s ease-out forwards;
    }

    .stage-footer {
        display: flex;
        box-sizing: border-box;
        flex: 0 0 auto;
        min-height: 0;
        flex-direction: column;
        gap: 8px;
        padding: 10px 14px;
        border-radius: 10px;
        background: rgba(10, 30, 50, 0.55);
    }

    .chat-log {
        display: flex;
        flex: 1 1 auto;
        min-height: 96px;
        padding: 6px 10px;
        overflow-y: auto;
        border-radius: 6px;
        flex-direction: column;
        gap: 3px;
        background: rgba(255, 255, 255, 0.92);
    }

    .chat-log-line {
        margin: 0;
        overflow-wrap: anywhere;
        color: #1a1440;
        font-size: 14px;
        line-height: 1.35;
    }

    .chat-log-line.correct {
        color: #1c7a4a;
        font-weight: 800;
    }

    .chat-log-nickname {
        color: #2f6fa8;
        font-weight: 800;
    }

    .answer-form {
        display: flex;
        flex: 0 0 44px;
        gap: 8px;
    }

    .answer-form input {
        min-width: 0;
        flex: 1;
    }

    .answer-form button {
        padding: 10px 18px;
    }

    .correct-notice {
        margin: 0;
        flex: 0 0 auto;
        color: #a7f0c4;
        font-size: 14px;
        font-weight: 700;
    }

    @media (max-width: 1280px) {
        .stage-shell {
            max-width: 1040px;
            height: 760px;
        }

        .prompt-board {
            min-height: 120px;
        }

        .prompt-text {
            font-size: 24px;
        }
        
        .hint-toggle-button,
        .skip-round-button {
            padding: 5px 8px;
            font-size: 12px;
        }

        .leave-room-button {
            padding: 5px 10px;
            font-size: 13px;
        }
        
        .hint-display-box {
            padding: 10px 12px;
        }

        .hint-box-content {
            font-size: 19px;
        }
    }

    @media (max-width: 900px) {
        .play-page {
            padding: 0;
        }

        .stage-shell {
            max-width: 640px;
            height: 780px;
        }

        .seat-stage {
            grid-template-columns: repeat(4, 1fr);
            row-gap: 50px;
            padding: 70px 10px 10px;
        }

        .hint-display-box {
            width: 90%;
        }

        .prompt-text {
            font-size: 22px;
        }
    }

    @media (max-width: 640px) {
        .play-page {
            height: auto;
            min-height: calc(100dvh - (var(--page-padding-y) * 2));
            padding: 0;
            overflow: visible;
        }

        .stage-shell {
            max-width: 100%;
            height: auto;
            margin-top: 0;
        }

        .stage-header {
            grid-template-columns: auto 1fr auto;
        }

        .prompt-heading-row {
            grid-template-columns: auto 1fr auto;
        }

        .hint-toggle-button,
        .skip-round-button {
            font-size: 11px;
            padding: 4px 7px;
        }

        .leave-room-button {
            font-size: 12px;
            padding: 4px 10px;
        }

        .hint-display-box {
            width: 100%;
        }

        .hint-box-content {
            font-size: 16px;
            letter-spacing: 2px;
        }

        .seat-stage {
            grid-template-columns: repeat(2, 1fr);
            row-gap: 48px;
            padding: 66px 8px 8px;
        }

        .seat-stage-wrap {
            min-height: 640px;
        }

        .prompt-board {
            min-height: 110px;
        }

        .prompt-text {
            font-size: 19px;
        }

        .chat-log {
            min-height: 110px;
        }
    }
</style>