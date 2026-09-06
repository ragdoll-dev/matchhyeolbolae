<!--
  src/routes/room/[code]/result/+page.svelte

  결과 화면 — 랭킹보드 확대 + 방장 자동 대기실 이동

  변경 사항
  - 16인 기준 랭킹 카드 크기 확대
  - 랭킹보드와 하단 버튼 사이 여백 확대
  - 방장은 결과 페이지 진입 후 10초 뒤 자동으로 대기실 이동
  - 자동 이동 타이머는 onDestroy에서 정리
  - 버튼을 직접 눌러도 중복 이동하지 않음
-->
<script lang="ts">
    import { goto } from '$app/navigation';
    import { page } from '$app/stores';
    import { FRAME_HEIGHT, FRAME_WIDTH, getIdleFramePosition, sheetUrl, type AvatarGender } from '$lib/avatarSprite';
    import { toErrorMessage } from '$lib/errorMessage';
    import { getRoomPlayerId, removeRoomPlayerId } from '$lib/roomPlayerStorage';
    import {
    	subscribeToRoom,
    	unsubscribeFromRoom,
    	type PlayerRow,
    	type RoomRow
    } from '$lib/roomRealtime';
    import { supabase } from '$lib/supabaseClient';
    import type { RealtimeChannel } from '@supabase/supabase-js';
    import { onDestroy, onMount } from 'svelte';

    const roomCode = $page.params.code;
    const HOST_AUTO_RETURN_MS = 10000;

    let room = $state<RoomRow | null>(null);
    let players = $state<PlayerRow[]>([]);
    let myPlayerId = $state<string | null>(null);
    let isLoading = $state(true);
    let loadError = $state<string | null>(null);
    let actionError = $state<string | null>(null);
    let isRestarting = $state(false);
    let isLeaving = $state(false);
    let isAutoReturning = $state(false);
    let hostAutoReturnTimer: ReturnType<typeof setTimeout> | null = null;
    let channel: RealtimeChannel | null = null;
    let previousHtmlOverflow = '';
    let previousBodyOverflow = '';

    let myPlayer = $derived(players.find((player) => player.id === myPlayerId) ?? null);
    let isHost = $derived(myPlayer?.is_host === true);

    type RankedPlayer = PlayerRow & { rank: number };

    let rankedPlayers = $derived.by<RankedPlayer[]>(() => {
        const sorted = [...players].sort((a, b) => b.score - a.score);
        const result: RankedPlayer[] = [];
        let rank = 0;
        let lastScore: number | null = null;

        sorted.forEach((player, index) => {
            if (lastScore === null || player.score !== lastScore) {
                rank = index + 1;
                lastScore = player.score;
            }
            result.push({ ...player, rank });
        });

        return result;
    });

    let columnCount = $derived(players.length <= 4 ? Math.max(1, players.length) : 4);

    let rankingRows = $derived.by<RankedPlayer[][]>(() => {
        const rows: RankedPlayer[][] = [];
        for (let index = 0; index < rankedPlayers.length; index += columnCount) {
            rows.push(rankedPlayers.slice(index, index + columnCount));
        }
        return rows;
    });

    let rowCount = $derived(Math.max(1, rankingRows.length));

    /*
      고정 px 크기 프리셋.

      수동으로 랭킹 카드 크기를 조절하려면 아래 객체의 값을 직접 수정하세요.
      - cardW: 카드 가로 크기
      - cardH: 카드 세로 크기
      - avatarW: 아바타 영역 가로 크기
      - avatarScale: 아바타 확대/축소 배율
      - nickFont: 닉네임 글자 크기
      - scoreFont: 점수 글자 크기
      - badgeFont: 순위/메달 뱃지 글자 크기

      예시: 16인 화면을 더 크게 만들려면 default의
      cardW: 120 -> 132, cardH: 156 -> 170 처럼 변경하세요.
      카드 크기를 키우면 ranking-board-wrap 전체 폭/높이도 함께 커집니다.
    */
    let sizePreset = $derived.by(() => {
        switch (rowCount) {
            case 1:
                return { cardW: 190, cardH: 232, avatarW: 104, avatarScale: 1.42, nickFont: 15, scoreFont: 15.5, badgeFont: 14.5 };
            case 2:
                return { cardW: 164, cardH: 204, avatarW: 92, avatarScale: 1.22, nickFont: 13.5, scoreFont: 14, badgeFont: 13 };
            case 3:
                return { cardW: 140, cardH: 176, avatarW: 77, avatarScale: 1.02, nickFont: 12, scoreFont: 12.5, badgeFont: 11.5 };
            default:
                // 16인 화면 기본값. 기존 102x132px에서 확대.
                return { cardW: 120, cardH: 156, avatarW: 66, avatarScale: 0.88, nickFont: 10.5, scoreFont: 11, badgeFont: 10 };
        }
    });

    let resultStyle = $derived(
        `--rank-rows: ${rowCount}; --card-w: ${sizePreset.cardW}px; --card-h: ${sizePreset.cardH}px; --avatar-w: ${sizePreset.avatarW}px; --avatar-scale: ${sizePreset.avatarScale}; --nick-font: ${sizePreset.nickFont}px; --score-font: ${sizePreset.scoreFont}px; --badge-font: ${sizePreset.badgeFont}px;`
    );

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

    function rankLabel(rank: number): string {
        return `${rank}위`;
    }

    function medalForRank(rank: number): string | null {
        if (rank === 1) return '🥇';
        if (rank === 2) return '🥈';
        if (rank === 3) return '🥉';
        return null;
    }

    function clearHostAutoReturnTimer() {
        if (hostAutoReturnTimer) {
            clearTimeout(hostAutoReturnTimer);
            hostAutoReturnTimer = null;
        }
    }

    function scheduleHostAutoReturn() {
        clearHostAutoReturnTimer();
        if (!isHost || !room || isAutoReturning) return;

        hostAutoReturnTimer = setTimeout(() => {
            hostAutoReturnTimer = null;
            void handleRestartRoom(true);
        }, HOST_AUTO_RETURN_MS);
    }

    async function loadResult() {
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

            // 방장이 이미 대기실로 되돌린 경우, result 페이지에 남지 않고 즉시 이동
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
            myPlayerId = getRoomPlayerId(roomCode);

            channel = subscribeToRoom(room.id, {
                onRoomChange: (row) => {
                    room = row;
                    if (row.status === 'waiting') {
                        clearHostAutoReturnTimer();
                        goto(`/room/${roomCode}`);
                    }
                },
                onPlayerChange: (row, eventType, oldRow) => {
                    if (eventType === 'DELETE') {
                        const deletedPlayerId = oldRow?.id;
                        if (deletedPlayerId) {
                            players = players.filter((player) => player.id !== deletedPlayerId);
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
                }
            });

            const { data: latestRoomData, error: latestRoomError } = await supabase
                .from('rooms')
                .select('*')
                .eq('id', room.id)
                .single();

            if (!latestRoomError && latestRoomData) {
                if (latestRoomData.status === 'waiting') {
                    clearHostAutoReturnTimer();
                    if (channel) unsubscribeFromRoom(channel);
                    goto(`/room/${roomCode}`);
                    return;
                }
                room = latestRoomData as RoomRow;
            }
        } catch (err) {
            loadError = toErrorMessage(err);
        } finally {
            isLoading = false;
        }
    }

    async function handleRestartRoom(isAutomatic = false) {
        if (!room || isRestarting || isLeaving || isAutoReturning) return;

        clearHostAutoReturnTimer();
        isRestarting = true;
        isAutoReturning = isAutomatic;
        actionError = null;

        try {
            const { error } = await supabase.rpc('restart_room', { p_room_id: room.id });
            if (error) throw error;

            if (myPlayerId) {
                const { error: reconnectError } = await supabase.rpc('mark_reconnected', {
                    p_player_id: myPlayerId
                });

                if (reconnectError) {
                    console.warn('[result-page] 재접속 처리 실패:', reconnectError);
                }
            }

            goto(`/room/${roomCode}`);
        } catch (err) {
            isAutoReturning = false;
            actionError = toErrorMessage(err);
        } finally {
            isRestarting = false;
        }
    }

    async function handleLeaveRoom() {
        if (!room || !myPlayerId || isLeaving || isRestarting || isAutoReturning) return;

        clearHostAutoReturnTimer();
        isLeaving = true;
        actionError = null;

        try {
            const { error } = await supabase.rpc('leave_room', {
                p_room_id: room.id
            });

            if (error) throw error;

            removeRoomPlayerId(roomCode);
            goto('/');
        } catch (err) {
            actionError = toErrorMessage(err);
            isLeaving = false;
        }
    }

    onMount(() => {
        previousHtmlOverflow = document.documentElement.style.overflow;
        previousBodyOverflow = document.body.style.overflow;

        document.documentElement.style.overflow = 'hidden';
        document.body.style.overflow = 'hidden';

        void loadResult();
    });

    onDestroy(() => {
        document.documentElement.style.overflow = previousHtmlOverflow;
        document.body.style.overflow = previousBodyOverflow;

        clearHostAutoReturnTimer();
        if (channel) unsubscribeFromRoom(channel);
    });

    $effect(() => {
        if (!isLoading && isHost && room?.status === 'finished') {
            scheduleHostAutoReturn();
        }
    });

</script>

<div class="result-page">
    <div class="result-shell" style={resultStyle}>
        {#if isLoading}
            <p class="status-text text-center">결과를 불러오는 중...</p>
        {:else if loadError}
            <p class="status-text error text-center">{loadError}</p>
        {:else if room}
            <header class="result-header text-center">
                <p class="result-eyebrow">게임 종료</p>
                <h1 class="result-title">{room.title}</h1>
                <p class="result-meta">총 {room.total_rounds}라운드 · 참가자 {players.length}명</p>
            </header>

            {#if actionError}
                <p class="status-text error compact text-center">{actionError}</p>
            {/if}

            <section class="ranking-board-wrap" aria-label="전체 게임 순위">
                <div class="ranking-board">
                    {#each rankingRows as rankingRow, rowIndex (rowIndex)}
                        <div class="ranking-row">
                            {#each rankingRow as player (player.id)}
                                <article class="rank-card rank-{player.rank} {player.id === myPlayerId ? 'me' : ''}">
                                    <span class="rank-badge">
                                        {#if medalForRank(player.rank)}
                                            {medalForRank(player.rank)}
                                        {:else}
                                            {rankLabel(player.rank)}
                                        {/if}
                                    </span>

                                    <div class="rank-avatar-wrap">
                                        <span
                                            class="rank-avatar"
                                            style={`width: ${FRAME_WIDTH}px; height: ${FRAME_HEIGHT}px; ${spriteStyle(player.character_index, player.avatar_gender)}`}
                                            aria-hidden="true"
                                        ></span>
                                    </div>

                                    <span class="rank-nickname" title={player.nickname}>
                                        <span class="rank-nickname-line">{splitNicknameLines(player.nickname)[0]}</span>
                                        <span class="rank-nickname-line">{splitNicknameLines(player.nickname)[1]}</span>
                                    </span>
                                    <span class="rank-score">{player.score}점</span>
                                </article>
                            {/each}
                        </div>
                    {/each}
                </div>
            </section>

            <footer class="result-footer">
                {#if isHost}
                    <p class="auto-return-text">
                        {isAutoReturning ? '대기실로 이동하는 중...' : '10초 동안 동작이 없을 시 대기실로 자동 이동합니다.'}
                    </p>
                    <button
                        type="button"
                        class="btn btn-primary restart-btn"
                        onclick={() => handleRestartRoom(false)}
                        disabled={isRestarting || isLeaving || isAutoReturning}
                    >
                        {isRestarting ? '이동 중...' : '대기실로 돌아가기'}
                    </button>
                {:else}
                    <p class="waiting-text">방장이 다시 시작하면 자동으로 대기실로 이동합니다.</p>
                {/if}
            </footer>
        {/if}
    </div>
</div>

<style>
    /*
      결과 페이지 전체

      - 공통 상단 헤더 56px을 제외한 영역만 사용
      - 상하 padding으로 인한 추가 높이 방지
      - 전체 페이지 스크롤 방지
      - margin-top 음수값으로 결과 콘텐츠를 조금 위로 이동
    */
    .result-page {
        display: flex;
        width: 100%;
        height: calc(100dvh - 56px);
        min-height: 0;
        align-items: flex-start;
        justify-content: center;
        box-sizing: border-box;
        margin-top: -12px;
        padding: 0 16px;
        overflow: hidden;
    }


    /*
      결과 콘텐츠 전체

      shell이 result-page 내부 높이를 넘지 않도록 고정합니다.
    */
    .result-shell {
        display: flex;
        width: 100%;
        max-width: 960px;
        height: 100%;
        min-height: 0;
        flex-direction: column;
        gap: 6px;
        overflow: hidden;
    }


    .status-text {
        padding: 48px 0;
        color: var(--color-text-secondary);
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
      결과 헤더

      불필요한 위/아래 여백을 제거합니다.
    */
    .result-header {
        flex: 0 0 auto;
        margin: 0;
        padding: 0;
    }


    .result-eyebrow {
        margin: 0;
        color: var(--color-accent);
        font-size: 14px;
        font-weight: 900;
        letter-spacing: 0.1em;
    }


    .result-title {
        max-width: 100%;
        margin: 0 0 2px;
        overflow: hidden;
        color: var(--color-text-primary);
        font-size: 30px;
        font-weight: 900;
        line-height: 1.1;
        text-overflow: ellipsis;
        white-space: nowrap;
    }


    .result-meta {
        margin: 0;
        color: var(--color-text-secondary);
        font-size: 14px;
        line-height: 1.1;
    }


    /*
      랭킹보드 외곽
    */
    .ranking-board-wrap {
        display: flex;
        max-width: fit-content;
        max-height: 100%;
        min-height: 0;
        margin: 0 auto;
        align-items: center;
        border: 2px solid var(--color-border);
        border-radius: 16px;
        background: radial-gradient(
            ellipse at center 30%,
            #5b4fe0 0%,
            #4436b8 70%,
            #372c8f 100%
        );
    }


    .ranking-board {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 12px;
        flex-direction: column;
        gap: 24px;
    }


    .ranking-row {
        display: flex;
        align-items: stretch;
        justify-content: center;
        gap: 12px;
    }


    /*
      순위 카드

      카드 크기는 script의 sizePreset에서 결정됩니다.

      수동 조절 방법:
      script의 sizePreset.default에서 아래 값을 수정하세요.

      - cardW: 카드 가로 크기
      - cardH: 카드 세로 크기
      - avatarW: 아바타 영역 크기
      - avatarScale: 아바타 확대 배율
      - nickFont: 닉네임 크기
      - scoreFont: 점수 크기
      - badgeFont: 순위 뱃지 크기

      FHD에서 세로 스크롤이 생기면 cardH를 먼저 낮추세요.
      예: cardH: 156 -> 148
    */
    .rank-card {
        display: grid;
        width: var(--card-w);
        height: var(--card-h);
        box-sizing: border-box;
        padding: 9px 8px;
        overflow: hidden;
        border: 2px solid var(--color-border);
        border-radius: 12px;
        background: var(--color-surface);
        grid-template-rows: 20% 46% 18% 16%;
        justify-items: center;
        align-items: center;
    }


    .rank-card.me {
        border-color: var(--color-accent);
        box-shadow: 0 0 0 2px rgba(255, 213, 74, 0.32);
    }


    .rank-card.rank-1 {
        background: #5b4fe0;
        box-shadow: 0 5px 16px rgba(255, 213, 74, 0.35);
    }


    .rank-badge {
        display: inline-flex;
        max-width: 100%;
        align-items: center;
        justify-content: center;
        padding: 4px 9px;
        border-radius: 7px;
        background: var(--color-surface-dark);
        color: var(--color-text-secondary);
        font-size: var(--badge-font);
        font-weight: 900;
        line-height: 1;
    }


    .rank-card.rank-1 .rank-badge {
        background: var(--color-accent);
        color: var(--color-accent-text);
    }


    .rank-card.rank-2 .rank-badge {
        background: #c7c9d9;
        color: #33344a;
    }


    .rank-card.rank-3 .rank-badge {
        background: #e0a469;
        color: #4a2c0a;
    }


    .rank-avatar-wrap {
        display: flex;
        width: var(--avatar-w);
        height: 100%;
        min-height: 0;
        align-items: flex-end;
        justify-content: center;
        overflow: hidden;
    }


    .rank-card.rank-1 .rank-avatar-wrap {
        width: calc(var(--avatar-w) * 1.1);
    }


    .rank-avatar {
        display: block;
        flex: 0 0 auto;
        background-repeat: no-repeat;
        image-rendering: pixelated;
        transform: scale(var(--avatar-scale));
        transform-origin: bottom center;
    }


    .rank-card.rank-1 .rank-avatar {
        transform: scale(calc(var(--avatar-scale) * 1.1));
    }


    .rank-nickname {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 1px;
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
        overflow: hidden;
        color: var(--color-text-primary);
        font-size: var(--nick-font);
        font-weight: 800;
        line-height: 1.15;
        text-align: center;
    }

    .rank-nickname-line {
        display: block;
        width: 100%;
        min-height: 1em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .rank-nickname-line:empty {
        min-height: 0;
    }

    .rank-score {
        color: var(--color-accent);
        font-size: var(--score-font);
        font-weight: 900;
        line-height: 1;
    }


    /*
      하단 버튼 영역

      랭킹보드와 버튼 사이의 간격을 최소화하면서도
      버튼이 랭킹보드에 붙어 보이지 않도록 30px 여백을 둡니다.
    */
    .result-footer {
        display: flex;
        flex: 0 0 auto;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        margin-top: 20px;
        padding: 0;
    }


    .auto-return-text,
    /*
        마진 수정해서 랭킹보드랑 텍스트 띄우기
    */
    .waiting-text {
        margin: 30px;
        color: var(--color-text-secondary);
        font-size: 14px;
        line-height: 1.1;
    }


    .restart-btn {
        padding: 10px 36px;
    }


    .leave-btn {
        padding: 10px 26px;
    }


    /*
      FHD 전용 보정

      901px~1920px 구간에서는 상단/행 간격을 더 줄여
      4행 랭킹보드가 한 화면에 들어오도록 합니다.
    */
    @media (min-width: 901px) and (max-width: 1920px) {
        .result-page {
            height: calc(100dvh - 56px);
            margin-top: -12px;
            padding-top: 0;
            padding-bottom: 0;
        }


        .result-shell {
            gap: 4px;
        }


        .ranking-board {
            padding: 10px;
            gap: 20px;
        }


        .ranking-row {
            gap: 10px;
        }


        .result-footer {
            margin-top: 2px;
            gap: 5px;
        }
    }


    /*
      태블릿
    */
    @media (max-width: 900px) {
        .result-page {
            height: calc(100dvh - 56px);
            margin-top: -8px;
            padding: 0 12px;
        }


        .result-shell {
            max-width: 640px;
        }
    }


    /*
      모바일

      모바일에서도 전체 페이지 스크롤을 막고,
      카드만 82%로 축소합니다.
    */
    @media (max-width: 620px) {
        .result-page {
            width: 100%;
            height: 100dvh;
            min-height: 0;
            margin-top: 0;
            padding: 8px;
            overflow: hidden;
        }


        .result-shell {
            width: 100%;
            height: 100%;
            min-height: 0;
            gap: 4px;
            overflow: hidden;
        }


        .ranking-board {
            padding: 8px;
            gap: 10px;
        }


        .ranking-row {
            gap: 6px;
        }


        .rank-card {
            width: calc(var(--card-w) * 0.82);
            height: calc(var(--card-h) * 0.82);
            border-radius: 8px;
        }


        .result-title {
            font-size: 24px;
        }


        .result-footer {
            margin-top: 2px;
            gap: 5px;
        }
    }
</style>
