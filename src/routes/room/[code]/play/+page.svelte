<!--
  src/routes/room/[code]/play/+page.svelte

  게임 진행 화면 — 마추기(machugi.io) 방식 반응형 원칙 적용 + 이중 패딩 버그 수정
  + 4K 해상도 상단 정렬 고정 + 채팅 스크롤 밀림 수정 + 정답 배지/채팅 즉시 반영

  버그 원인
  - page-container(app.css)가 이미 상하 40px 패딩을 주고 있는데,
    play-page 가 height 계산에는 그 값만 빼면서 자체 padding(16px/8px)을
    추가로 더해서 실제 사용 가능한 공간보다 stage-shell 의 height 가 커져
    좌석/채팅창 등 내부 요소가 여러 겹으로 겹쳐 보이는 현상이 발생했다.

  추가 수정 사항 (누적)
  1. .play-page 의 align-items 를 center → flex-start 로 변경.
     center 정렬은 뷰포트 세로 크기에 비례해 위쪽 여백이 커지므로
     4K 처럼 세로가 큰 해상도에서 스테이지가 화면 중앙 훨씬 아래로 내려가는
     문제가 있었다. flex-start + 고정 margin-top 으로 해상도 무관하게
     항상 동일한 위치에 스테이지가 위치하도록 고정했다.

  2. 채팅 로그 스크롤을 requestAnimationFrame 한 번으로 처리했으나,
     정답 배지(correct-player-banner)가 동시에 나타나면서 형제 요소의
     레이아웃이 한 번 더 리플로우되어 scrollHeight 가 늦게 갱신되는
     문제가 있었다. ResizeObserver 로 .chat-log 자체의 실제 크기 변화를
     감지해서, 몇 차례 리플로우가 겹쳐도 항상 최종 상태 기준으로
     맨 아래 스크롤을 다시 고정하도록 변경했다.

  3. onChatMessage 에서 정답 메시지(is_correct_answer)를 받는 즉시
     showCorrectWrongOverlays 를 호출해 O/X 배지와 정답자 배너를
     그 자리에서 바로 그리도록 변경. 서버의 game_sessions UPDATE 를
     기다리지 않는다.

  4. 채팅 로그 자체가 입력 후 1~2초 늦게 뜨는 문제 수정. 기존에는
     채팅 로그가 오직 Realtime onChatMessage 이벤트로만 추가되어,
     RPC 응답 이후 Realtime 브로드캐스트 왕복 지연을 그대로 떠안았다.
     이제 본인이 보낸 메시지는 send_message RPC 응답을 받는 즉시
     낙관적으로 로그에 추가하고, 이후 Realtime 으로 동일 메시지가
     도착하면 player_id 로 판별해 중복 추가를 막는다. 다른 플레이어의
     메시지는 기존처럼 Realtime 수신 시점에 추가된다.
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

    let bubbles = $state<Record<string, BubbleState>>({});
    let bouncingPlayerIds = $state<Record<string, true>>({});
    let correctOverlay = $state<Record<string, true>>({});
    let wrongOverlay = $state<Record<string, true>>({});
    let chatLog = $state<ChatLogEntry[]>([]);
    let seenChatMessageIds = new Set<string>();

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

        // ⚠️ 테스트용 임시 코드: 방장을 2열 첫 자리(index 8)로 강제 배치
        if (host) slots[8] = host;

        let seatIndex = 0;
        for (const player of players) {
            if (player.is_host || seatIndex >= TOTAL_SEATS) continue;
            if (seatIndex === 8) seatIndex += 1; // 방장 자리(8)는 건너뜀
            slots[seatIndex] = player;
            seatIndex += 1;
        }

        return slots;
    });


    // ==========================
    //           원본
    // ==========================
    // let seats = $derived.by(() => {
    //     const slots: (PlayerRow | null)[] = new Array(TOTAL_SEATS).fill(null);
    //     const host = players.find((p) => p.is_host);

    //     if (host) slots[0] = host;

    //     let seatIndex = 1;
    //     for (const player of players) {
    //         if (player.is_host || seatIndex >= TOTAL_SEATS) continue;
    //         slots[seatIndex] = player;
    //         seatIndex += 1;
    //     }

    //     return slots;
    // });

    let correctPlayerNickname = $derived.by(() => {
        const correctId = Object.keys(correctOverlay)[0];
        if (!correctId) return null;
        return players.find((player) => player.id === correctId)?.nickname ?? null;
    });

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

    /*
      채팅 로그에 새 줄을 추가한 뒤 스크롤을 맨 아래로 고정한다.
      requestAnimationFrame 으로 브라우저가 레이아웃을 확정한 다음 프레임에
      한 번 스크롤을 맞추고, 이후 정답 배지 등장 등으로 형제 요소가 다시
      리플로우되어 .chat-log 의 실제 크기가 바뀌는 경우까지는
      ResizeObserver(onMount 에서 등록)가 뒤이어 보정한다.
    */
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

    async function loadQuestionContext(questionId: string | null, phase: string) {
        if (!questionId) {
            currentPrompt = null;
            currentCorrectAnswers = null;
            return;
        }

        if (phase === 'reveal') {
            const { data } = await supabase
                .from('questions')
                .select('prompt, correct_answers')
                .eq('id', questionId)
                .single();

            if (data) {
                currentPrompt = data.prompt as string;
                currentCorrectAnswers = data.correct_answers as string[];
            }

            // 정답 배지는 onChatMessage/handleSendMessage 에서 이미 즉시
            // 반영되므로, 여기서는 아직 배지가 비어 있는 경우
            // (예: 시간 초과로 아무도 못 맞혀 reveal 에 진입한 경우)에
            // 한해서만 서버 기준으로 보정한다.
            if (Object.keys(correctOverlay).length === 0 && Object.keys(wrongOverlay).length === 0) {
                const { data: sessionData } = await supabase
                    .from('game_sessions')
                    .select('first_correct_player_id')
                    .eq('question_id', questionId)
                    .order('question_started_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                showCorrectWrongOverlays(sessionData?.first_correct_player_id ?? null);
            }
            return;
        }

        const { data } = await supabase
            .from('questions_public')
            .select('prompt')
            .eq('id', questionId)
            .single();

        if (data) {
            currentPrompt = data.prompt as string;
            currentCorrectAnswers = null;
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

            // 최초 조회 시점에 이미 게임이 끝났거나 대기실로 되돌아간 경우 즉시 이동
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
            if (session) await loadQuestionContext(session.question_id, session.phase);

            try {
                await syncServerClock();
                isClockSynced = true;
            } catch (err) {
                clockSyncError = toErrorMessage(err);
            }

            channel = subscribeToRoom(room.id, {
                onRoomChange: (row) => {
                    room = row;
                    if (row.status === 'finished') {
                        goto(`/room/${roomCode}/result`);
                    } else if (row.status === 'waiting') {
                        goto(`/room/${roomCode}`);
                    }
                },
                onGameSessionChange: async (row) => {
                    const phaseChanged = session?.id !== row.id || session?.phase !== row.phase;
                    session = row;

                    if (phaseChanged) {
                        chatInput = '';
                        pendingMessageText = null;
                        await loadQuestionContext(row.question_id, row.phase);
                        await tick();
                        requestAnimationFrame(scrollChatToBottom);
                        if (row.phase === 'question') await focusAnswerInput();
                    }
                },
                onPlayerChange: (row, eventType, oldRow) => {
                    if (eventType === 'DELETE') {
                        const removedId = oldRow?.id ?? row?.id;
                        if (removedId) {
                            players = players.filter((player) => player.id !== removedId);
                        }
                        return;
                    }

                    if (!row) return;

                    const index = players.findIndex((player) => player.id === row.id);
                    if (index === -1) {
                        players = [...players, row];
                        return;
                    }

                    const next = [...players];
                    next[index] = row;
                    players = next;
                },
                onChatMessage: (row: ChatMessageRow) => {
                    showBubble(row.player_id, row.message, row.is_correct_answer);
                    triggerBounce(row.player_id);

                    // 본인이 보낸 메시지는 handleSendMessage 에서 RPC 응답을
                    // 받는 시점에 이미 로그에 추가했으므로, Realtime 으로
                    // 다시 도착해도 중복 추가하지 않는다(appendChatLog 내부의
                    // seenChatMessageIds 로도 한 번 더 걸러진다).
                    if (row.player_id !== myPlayerId) {
                        const nickname = players.find((p) => p.id === row.player_id)?.nickname ?? '???';
                        void appendChatLog({
                            id: row.id,
                            nickname,
                            message: row.message,
                            isCorrect: row.is_correct_answer
                        });
                    }

                    // 정답 메시지를 받는 즉시 O/X 배지와 정답자 배너를 그린다.
                    // 서버의 reveal_answer 응답이나 game_sessions UPDATE 를
                    // 기다리지 않아도 되므로, 모든 클라이언트에서 판정과
                    // 동시에 화면이 갱신된다.
                    if (
                        row.is_correct_answer &&
                        session?.phase === 'question' &&
                        row.question_id === session.question_id
                    ) {
                        showCorrectWrongOverlays(row.player_id);

                        if (isHost) void handleRevealAnswer();
                    }
                }
            });

            // subscribeToRoom 호출 전과 후 사이에 방장이 이미 end_game 이나
            // restart_room 을 실행해버렸을 가능성을 방어한다. Realtime
            // Postgres Changes 는 구독이 시작된 "이후"의 이벤트만 전달하므로,
            // 구독 시작 직전에 이미 지나간 UPDATE(playing -> finished,
            // finished -> waiting)는 영원히 수신하지 못할 수 있다. 따라서
            // 구독을 건 직후 최신 상태를 한 번 더 직접 조회해서 방어한다.
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

            // 채팅 로그는 Realtime 브로드캐스트를 기다리지 않고, RPC 응답을
            // 받는 즉시 본인 메시지를 낙관적으로 추가한다. 이렇게 하면
            // 입력 후 로그에 뜨는 체감 속도가 말풍선과 동일해진다.
            // 이후 Realtime 으로 같은 메시지가 도착하면 player_id 및
            // seenChatMessageIds 로 걸러져 중복 추가되지 않는다.
            const nickname = myPlayer?.nickname ?? '???';
            void appendChatLog({
                id: `local-${myPlayerId}-${Date.now()}`,
                nickname,
                message: text,
                isCorrect
            });

            if (isCorrect && session?.phase === 'question') {
                showCorrectWrongOverlays(myPlayerId);
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
        if (chatLogResizeObserver) chatLogResizeObserver.disconnect();
        for (const timer of Object.values(bounceTimers)) clearTimeout(timer);
    });
</script>

<div class="play-page">
    {#if isLoading}
        <p class="status-text text-center">게임 정보를 불러오는 중...</p>
    {:else if loadError}
        <p class="status-text error text-center">{loadError}</p>
    {:else if room && session}
        <div class="stage-shell">
            <header class="stage-header">
                <span class="round-badge">{room.current_round} / {room.total_rounds} 라운드</span>
                <span class="timer-badge">{remainingSeconds}초</span>
            </header>

            {#if clockSyncError || actionError}
                <p class="status-text error compact text-center">{actionError ?? clockSyncError}</p>
            {/if}

            <div class="prompt-board">
                <span class="prompt-label">[{session.phase === 'question' ? '문제' : '정답 공개'}]</span>
                <p class="prompt-text">{currentPrompt ?? '문제를 불러오는 중...'}</p>
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

                                    <!-- 닉네임: 기존 위치 그대로, 6자+6자 2줄만 적용 -->
                                    <span class="seat-nickname-lines">
                                        <span class="seat-nickname-line">{splitNicknameLines(seatPlayer.nickname)[0]}</span>
                                        <span class="seat-nickname-line">{splitNicknameLines(seatPlayer.nickname)[1]}</span>
                                    </span>

                                    <!-- 점수 + 방장뱃지: 같은 줄, 점수가 왼쪽 그대로, 방장뱃지가 오른쪽 -->
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
    /*
      전체 배경: 뷰포트를 채우되, 내부 stage-shell 크기는 고정 px 기반이라
      화면이 커지면 배경 여백만 넓어진다.

      align-items 를 center 대신 flex-start 로 변경했다. center 정렬은
      남는 세로 공간의 절반을 위쪽 여백으로 만들기 때문에, FHD 에서는 여백이
      작아 자연스러웠지만 4K 처럼 세로 해상도가 커지면 스테이지가 화면 중앙
      훨씬 아래로 내려가 보이는 문제가 있었다. flex-start + stage-shell 의
      고정 margin-top 조합으로 해상도와 무관하게 항상 동일한 위치에 스테이지가
      위치하도록 고정했다.
    */
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

    /*
      스테이지 전체: 고정 px 크기.
      1280x860 을 기준 디자인으로 삼고, 화면이 작으면 브레이크포인트별로
      한 단계씩만 축소한다. 화면이 커져도 이 값 이상으로 늘어나지 않는다.

      margin-top 값은 FHD 기준으로 "지금 딱 좋다"고 확인된 여백을 고정값으로
      못박은 것이다. align-items: flex-start 덕분에 이 값은 해상도와 무관하게
      항상 동일하게 유지된다. 필요하면 이 숫자만 조정하면 된다.
    */
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

    /*
      헤더: 고정 높이, 고정 폰트 크기
    */
    .stage-header {
        display: flex;
        flex: 0 0 40px;
        align-items: center;
        justify-content: center;
        gap: 8px;
    }

    .round-badge,
    .timer-badge {
        padding: 6px 14px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 800;
    }

    .round-badge {
        background: #1c4a73;
        color: #eaf6ff;
    }

    .timer-badge {
        background: var(--color-accent);
        color: var(--color-accent-text);
    }

    /*
      문제 보드: 고정 높이 140px
    */
    .prompt-board {
        display: flex;
        flex: 0 0 140px;
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

    .prompt-label {
        color: #1c4a73;
        font-size: 16px;
        font-weight: 900;
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

    /*
      좌석 영역: 고정 높이 420px.
      말풍선(최대 74px) + 화살표 + 여유 공간을 top padding 에 고정으로 반영.
      2 열 말풍선이 1 열 부스를 가리지 않도록 row-gap 도 고정값으로 확보.
    */
    .seat-stage-wrap {
        position: relative;
        display: flex;
        flex: 0 0 420px;
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

    /*
      좌석 부스: 고정 높이 132px. 4K 에서도 FHD 와 완전히 동일한 크기.
    */
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

    /*
      말풍선: 고정 px 크기. 최대 높이 74px 이므로 위 padding(88px)이면 충분히 여유롭다.
    */
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

    /*
      푸터: 고정 높이 확보. 채팅 로그를 크게 잡고 입력창은 그 아래 고정.
    */
    .stage-footer {
        display: flex;
        box-sizing: border-box;
        flex: 1 1 auto;
        min-height: 0;
        flex-direction: column;
        gap: 8px;
        padding: 10px 14px;
        border-radius: 10px;
        background: rgba(10, 30, 50, 0.55);
    }

    /*
      채팅 로그: 고정 높이가 아니라 flex: 1 로 남는 공간을 모두 채운다.
      stage-shell 전체가 고정 px 이므로, 남는 세로 공간은 여기로만 흡수된다.
    */
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

    /*
      브레이크포인트 1: 1280px 미만 (노트북, 작은 데스크톱 창)
      stage-shell 자체를 한 단계 축소한 고정 크기로 교체한다.
      내부 좌석 크기, 폰트, gap 은 비율에 맞춰 함께 한 단계 축소.
    */
    @media (max-width: 1280px) {
        .stage-shell {
            max-width: 1040px;
            height: 760px;
        }

        .seat-stage-wrap {
            flex-basis: 360px;
        }

        .seat-stage {
            row-gap: 52px;
            padding: 74px 10px 10px;
        }

        .seat {
            max-width: 112px;
        }

        .seat-booth {
            height: 112px;
        }

        .seat-avatar {
            transform: scale(1.1);
        }

        .prompt-board {
            flex-basis: 120px;
        }

        .prompt-text {
            font-size: 24px;
        }
    }

    /*
      브레이크포인트 2: 900px 미만 (태블릿)
      8 열 그리드를 4 열로 변경. 좌석 크기는 유지한다.
    */
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

        .seat-stage-wrap {
            flex-basis: 460px;
        }

        .prompt-text {
            font-size: 22px;
        }
    }

    /*
      브레이크포인트 3: 640px 미만 (모바일)
      세로 스크롤 허용, 2 열 그리드로 축소.

      여기서도 자체 padding(8px)을 제거해 min-height 계산과 어긋나지 않게 한다.
    */
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

        .seat-stage {
            grid-template-columns: repeat(2, 1fr);
            row-gap: 48px;
            padding: 66px 8px 8px;
        }

        .seat-stage-wrap {
            flex-basis: auto;
            min-height: 640px;
        }

        .prompt-board {
            flex-basis: 110px;
        }

        .prompt-text {
            font-size: 19px;
        }

        .chat-log {
            min-height: 110px;
        }
    }
</style>
