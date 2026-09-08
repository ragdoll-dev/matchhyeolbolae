<!--
  src/routes/room/[code]/+page.svelte

  대기실 페이지 — Ready 시스템 적용 버전 + 미니게임 전체보기 모달 연동

  변경 사항 (기존 대비)
  - PlayerRow에 is_ready 필드 사용 (players 테이블에 컬럼 추가됨, DB 마이그레이션 완료)
  - 참가자용 handleToggleReady() 추가 → RPC 'toggle_player_ready' 호출
  - 방장 "게임 시작" 버튼 활성화 조건 변경:
      혼자 있거나(다른 참가자 없음) OR 자신을 제외한 모든 참가자가 is_ready === true 일 때만 활성화
  - 참가자 화면: 기존 waiting-text 자리를 레디 버튼으로 교체
  - 닉네임 옆에 host-badge와 동일한 스타일의 player-badge("준비완료") 추가
  - 서버(start_round RPC)에도 동일한 검증이 추가되어 있어 클라이언트 우회 불가
  - 미니게임 선택 UI를 인라인 리스트에서 MinigamePickerModal 공용 모달로 교체
    (전체보기 버튼 → 모달 오픈 → 검색/필터된 카드 그리드에서 선택)
  - 참가자(비방장)도 "미니게임 목록 보기" 버튼으로 동일한 모달을 열람 전용(readOnly)으로
    확인할 수 있음. 선택/변경은 방장만 가능 (MinigamePickerModal의 readOnly prop으로 제어)
-->
<script lang="ts">
    import { goto } from '$app/navigation';
    import { page } from '$app/stores';
    import { FRAME_HEIGHT, FRAME_WIDTH, getIdleFramePosition, sheetUrl, type AvatarGender } from '$lib/avatarSprite';
    import MinigamePickerModal from '$lib/components/MinigamePickerModal.svelte';
    import { toErrorMessage } from '$lib/errorMessage';
    import { getRoomPlayerId, removeRoomPlayerId } from '$lib/roomPlayerStorage';
    import { joinRoomPresence, type RoomPresenceHandle } from '$lib/roomPresence';
    import {
    	subscribeToRoom,
    	unsubscribeFromRoom,
    	type PlayerRow,
    	type RoomRow
    } from '$lib/roomRealtime';
    import { supabase } from '$lib/supabaseClient';
    import type { RealtimeChannel } from '@supabase/supabase-js';
    import { onDestroy, onMount, tick } from 'svelte';

    type MinigameOption = {
        minigame_id: string;
        slug: string;
        title: string;
        description: string | null;
        question_count: number;
    };

    type ContextMenuState = {
        playerId: string;
        nickname: string;
        x: number;
        y: number;
    };

    const roomCode = $page.params.code;
    const MIN_QUESTIONS_REQUIRED = 5;
    const NICKNAME_MAX_LENGTH = 12;
    const SAVED_NICKNAME_KEY = 'matchhyeolbolae:last_nickname';
    const SAVED_CHARACTER_KEY = 'matchhyeolbolae:last_character';

    let room = $state<RoomRow | null>(null);
    let players = $state<PlayerRow[]>([]);
    let myPlayerId = $state<string | null>(null);
    let minigames = $state<MinigameOption[]>([]);

    let isLoading = $state(true);
    let loadError = $state<string | null>(null);
    let actionError = $state<string | null>(null);
    let isStarting = $state(false);
    let isChangingMinigame = $state(false);
    let isLeaving = $state(false);
    let isTransferringHost = $state(false);
    let isTogglingReady = $state(false);
    let isMinigamePickerOpen = $state(false);

    let contextMenu = $state<ContextMenuState | null>(null);
    let selectedTransferPlayerId = $state<string | null>(null);
    let channel: RealtimeChannel | null = null;
    let presenceHandle: RoomPresenceHandle | null = null;

    let myPlayer = $derived(players.find((p) => p.id === myPlayerId) ?? null);
    let isHost = $derived(myPlayer?.is_host === true);
    let sortedPlayers = $derived(
        [...players].sort((a, b) => (a.is_host === b.is_host ? 0 : a.is_host ? -1 : 1))
    );
    let currentMinigame = $derived(
        minigames.find((m) => m.minigame_id === room?.minigame_id) ?? null
    );

    // 방장을 제외한 나머지 참가자들과, 그들의 레디 상태
    let otherPlayers = $derived(players.filter((p) => !p.is_host));
    let allOthersReady = $derived(otherPlayers.length > 0 && otherPlayers.every((p) => p.is_ready));
    // 방장 혼자 있거나, 나머지 전원이 레디했을 때만 시작 가능
    let canStartGame = $derived(
        !!room?.minigame_id && (otherPlayers.length === 0 || allOthersReady)
    );
    let myIsReady = $derived(myPlayer?.is_ready === true);

    let isEditingNickname = $state(false);
    let newNickname = $state('');
    let isUpdatingNickname = $state(false);
    let shouldRedirectToJoin = $state(false);
    let nicknameInputRef: HTMLInputElement | null = null;

    let isEditingCharacter = $state(false);
    let selectedAvatarGender = $state<'male' | 'female'>('male');
    let selectedCharacterIndex = $state(0);
    let isUpdatingCharacter = $state(false);

    function spriteStyle(characterIndex: number, gender: string): string {
        const resolvedGender = (gender === 'male' ? 'male' : 'female') as AvatarGender;
        const { sheet, x, y } = getIdleFramePosition(characterIndex, resolvedGender, 'down');
        return `background-image: url(${sheetUrl(sheet)}); background-position: -${x}px -${y}px;`;
    }

    async function refreshPlayers() {
        if (!room) return;

        const { data, error } = await supabase
            .from('players')
            .select('*')
            .eq('room_id', room.id);

        if (error) {
            console.warn('[room-page] 참가자 목록 갱신 실패:', error);
            return;
        }

        players = (data ?? []) as PlayerRow[];
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

            await refreshPlayers();

            const { data: minigameData, error: minigameError } = await supabase
                .from('minigames_with_question_count')
                .select('minigame_id, slug, title, description, question_count')
                .order('title');

            if (minigameError) throw minigameError;
            minigames = (minigameData ?? []) as MinigameOption[];

            myPlayerId = getRoomPlayerId(roomCode);
            if (!myPlayerId || !players.some((p) => p.id === myPlayerId)) {
                shouldRedirectToJoin = true;
                return;
            }

            channel = subscribeToRoom(room.id, {
                onRoomChange: (row) => {
                    room = row;
                    if (row.status === 'playing') {
                        goto(`/room/${roomCode}/play`);
                    }
                },
                onPlayerChange: (row, eventType, oldRow) => {
                    if (eventType === 'DELETE') {
                        const deletedPlayerId = oldRow?.id;
                        if (deletedPlayerId) {
                            players = players.filter((player) => player.id !== deletedPlayerId);

                            // 서버(sweep_stale_rooms)가 하트비트 끊김으로 나를 제거한 경우.
                            // 이 방은 이미 나에게 유효하지 않으므로 join 페이지가 아니라
                            // 안전하게 메인 홈으로 보낸다. join으로 보내면 방이 사라진 경우
                            // ROOM_NOT_FOUND 에러가 나기 때문이다.
                            if (deletedPlayerId === myPlayerId) {
                                removeRoomPlayerId(roomCode);
                                goto('/');
                                return;
                            }
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

            presenceHandle = joinRoomPresence(room.id, myPlayerId, () => room?.host_id ?? null);
        } catch (err) {
            loadError = toErrorMessage(err);
        } finally {
            isLoading = false;
        }
    }

    async function handleSelectMinigame(minigame: MinigameOption) {
        if (!room || isChangingMinigame || minigame.minigame_id === room.minigame_id) return;
        if (minigame.question_count < MIN_QUESTIONS_REQUIRED) return;

        isChangingMinigame = true;
        actionError = null;

        try {
            const { error } = await supabase.rpc('select_minigame', {
                p_room_id: room.id,
                p_minigame_id: minigame.minigame_id
            });
            if (error) throw error;
        } catch (err) {
            actionError = toErrorMessage(err);
        } finally {
            isChangingMinigame = false;
        }
    }

    async function handleStartGame() {
        if (!room || !canStartGame) return;

        isStarting = true;
        actionError = null;

        try {
            const { error } = await supabase.rpc('start_round', { p_room_id: room.id });
            if (error) throw error;
        } catch (err) {
            actionError = toErrorMessage(err);
        } finally {
            isStarting = false;
        }
    }

    async function handleToggleReady() {
        if (!myPlayerId || isHost || isTogglingReady) return;

        isTogglingReady = true;
        actionError = null;

        try {
            const { error } = await supabase.rpc('toggle_player_ready', {
                p_player_id: myPlayerId
            });
            if (error) throw error;
        } catch (err) {
            actionError = toErrorMessage(err);
        } finally {
            isTogglingReady = false;
        }
    }

    async function handleLeaveRoom() {
        if (!room || isLeaving) return;

        const confirmMessage = isHost
            ? '방 대기실에서 나가시겠습니까?'
            : '방 대기실에서 나가시겠습니까?';

        if (!confirm(confirmMessage)) return;

        isLeaving = true;
        actionError = null;

        try {
            if (isHost) {
                const { error } = await supabase.rpc('cancel_room', { p_room_id: room.id });
                if (error) throw error;
            } else if (myPlayerId) {
                const { error } = await supabase.rpc('leave_room', { p_room_id: room.id });
                if (error) throw error;
            }

            removeRoomPlayerId(roomCode);
            goto('/');
        } catch (err) {
            actionError = toErrorMessage(err);
            isLeaving = false;
        }
    }

    function canTransferTo(targetPlayer: PlayerRow) {
        return isHost && targetPlayer.id !== myPlayerId && !targetPlayer.is_host;
    }

    function handlePlayerContextMenu(event: MouseEvent, targetPlayer: PlayerRow) {
        if (!canTransferTo(targetPlayer)) return;

        event.preventDefault();
        event.stopPropagation();
        selectedTransferPlayerId = null;

        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        contextMenu = {
            playerId: targetPlayer.id,
            nickname: targetPlayer.nickname,
            x: Math.min(rect.left, window.innerWidth - 210),
            y: Math.min(rect.bottom + 6, window.innerHeight - 52)
        };
    }

    function handlePlayerClick(event: MouseEvent, targetPlayer: PlayerRow) {
        if (!canTransferTo(targetPlayer)) return;
        event.stopPropagation();
        contextMenu = null;
        selectedTransferPlayerId = selectedTransferPlayerId === targetPlayer.id ? null : targetPlayer.id;
    }

    function closeContextMenuOnly() {
        contextMenu = null;
    }

    async function transferHostTo(targetPlayerId: string, targetNickname: string) {
        if (!room || isTransferringHost) return;

        closeContextMenuOnly();
        if (!confirm(`${targetNickname}님에게 방장을 위임하시겠습니까?`)) return;

        isTransferringHost = true;
        actionError = null;

        try {
            const { error } = await supabase.rpc('transfer_host', {
                p_room_id: room.id,
                p_new_host_player_id: targetPlayerId
            });
            if (error) throw error;

            // 위임이 성공하면 인라인 패널을 확실히 닫는다.
            selectedTransferPlayerId = null;
        } catch (err) {
            actionError = toErrorMessage(err);
        } finally {
            isTransferringHost = false;
        }
    }

    async function handleTransferFromContextMenu() {
        if (!contextMenu) return;
        await transferHostTo(contextMenu.playerId, contextMenu.nickname);
    }

    async function handleTransferFromInline(targetPlayer: PlayerRow) {
        await transferHostTo(targetPlayer.id, targetPlayer.nickname);
    }

    function startEditNickname() {
        if (!myPlayer) return;

        // 이미 편집 중이면 취소
        if (isEditingNickname) {
            cancelEditNickname();
            return;
        }

        newNickname = myPlayer.nickname;
        isEditingNickname = true;
    }

    async function saveNickname() {
        const nickname = newNickname.trim();
        if (!myPlayerId || !nickname || nickname.length > NICKNAME_MAX_LENGTH || isUpdatingNickname) return;

        isUpdatingNickname = true;
        actionError = null;

        try {
            const { error } = await supabase.rpc('update_player_nickname', {
                p_player_id: myPlayerId,
                p_nickname: nickname
            });
            if (error) throw error;

            localStorage.setItem(SAVED_NICKNAME_KEY, nickname);
            isEditingNickname = false;
        } catch (err) {
            actionError = toErrorMessage(err);
        } finally {
            isUpdatingNickname = false;
        }
    }

    function cancelEditNickname() {
        isEditingNickname = false;
        newNickname = '';
    }

    function startEditCharacter() {
        if (!myPlayer) return;

        // 이미 편집 중이면 취소
        if (isEditingCharacter) {
            cancelEditCharacter();
            return;
        }

        selectedAvatarGender = myPlayer.avatar_gender === 'female' ? 'female' : 'male';
        selectedCharacterIndex = myPlayer.character_index;
        isEditingCharacter = true;
    }

    function selectAvatarGender(gender: 'male' | 'female') {
        selectedAvatarGender = gender;
        selectedCharacterIndex = 0;
    }

    async function saveCharacter() {
        if (!myPlayerId || isUpdatingCharacter) return;

        isUpdatingCharacter = true;
        actionError = null;

        try {
            const { error } = await supabase.rpc('update_player_character', {
                p_player_id: myPlayerId,
                p_avatar_gender: selectedAvatarGender,
                p_character_index: selectedCharacterIndex
            });
            if (error) throw error;

            localStorage.setItem(
                SAVED_CHARACTER_KEY,
                JSON.stringify({
                    gender: selectedAvatarGender,
                    index: selectedCharacterIndex
                })
            );

            isEditingCharacter = false;
        } catch (err) {
            actionError = toErrorMessage(err);
        } finally {
            isUpdatingCharacter = false;
        }
    }

    function cancelEditCharacter() {
        isEditingCharacter = false;
    }

    // 닉네임 편집 패널이 열리면 자동으로 포커스
    $effect(() => {
        if (isEditingNickname) {
            tick().then(() => {
                nicknameInputRef?.focus();
            });
        }
    });

    onMount(async () => {
        await loadInitialData();

        if (shouldRedirectToJoin) {
            removeRoomPlayerId(roomCode);
            goto(`/room/${roomCode}/join`);
            return;
        }

        if (myPlayerId && room) {
            try {
                await supabase.rpc('mark_reconnected', { p_player_id: myPlayerId });
            } catch (err) {
                console.warn('[room-page] 재접속 처리 실패:', err);
            }
        }

        window.addEventListener('click', closeContextMenuOnly);
        window.addEventListener('scroll', closeContextMenuOnly, true);
    });

    onDestroy(() => {
        if (channel) unsubscribeFromRoom(channel);
        if (presenceHandle) presenceHandle.stop();
        window.removeEventListener('click', closeContextMenuOnly);
        window.removeEventListener('scroll', closeContextMenuOnly, true);
    });
</script>

<div class="lobby-page">
    <div class="lobby-shell">
        {#if isLoading}
            <p class="status-text text-center">대기실 정보를 불러오는 중...</p>
        {:else if loadError}
            <p class="status-text error text-center">{loadError}</p>
        {:else if room}
            <header class="lobby-header text-center">
                <h1 class="room-title">{room.title}</h1>

                <div class="room-meta-area">
                    {#if myPlayer}
                        <div class="profile-actions">
                            <button
                                type="button"
                                class="btn btn-meta"
                                onclick={startEditNickname}
                            >
                                ✏️ 닉네임 변경
                            </button>

                            <button
                                type="button"
                                class="btn btn-meta"
                                onclick={startEditCharacter}
                            >
                                🧍 캐릭터 변경
                            </button>
                        </div>
                    {/if}

                    <div class="room-meta-row">
                        <span class="room-code-badge">방 번호 {room.code}</span>
                        <span class="meta-chip">{room.time_limit_seconds}초</span>
                        <span class="meta-chip">{room.total_rounds}라운드</span>
                        <span class="meta-chip">{players.length}/{room.max_players}명</span>
                    </div>
                </div>
            </header>

            {#if actionError}
                <p class="status-text error text-center">{actionError}</p>
            {/if}

            {#if isEditingNickname && myPlayer}
                <div class="nickname-edit-panel-header">
                    <input
                        class="input"
                        type="text"
                        bind:value={newNickname}
                        bind:this={nicknameInputRef}
                        placeholder="변경할 닉네임 (최대 12자)"
                        maxlength={NICKNAME_MAX_LENGTH}
                        onkeydown={(event) => {
                            if (event.key === 'Enter') saveNickname();
                            if (event.key === 'Escape') cancelEditNickname();
                        }}
                    />
                    <div class="nickname-edit-buttons">
                        <button
                            type="button"
                            class="btn btn-primary"
                            onclick={saveNickname}
                            disabled={isUpdatingNickname || !newNickname.trim()}
                        >
                            {isUpdatingNickname ? '저장 중...' : '저장'}
                        </button>
                        <button
                            type="button"
                            class="btn"
                            onclick={cancelEditNickname}
                            disabled={isUpdatingNickname}
                        >
                            취소
                        </button>
                    </div>
                </div>
            {/if}

            {#if isEditingCharacter && myPlayer}
                <div class="character-edit-panel-header">
                    <div class="character-edit-row">
                        <span class="character-edit-label">성별</span>
                        <div class="gender-row">
                            <button
                                type="button"
                                class="gender-btn {selectedAvatarGender === 'male' ? 'selected' : ''}"
                                onclick={() => selectAvatarGender('male')}
                            >
                                남성
                            </button>
                            <button
                                type="button"
                                class="gender-btn {selectedAvatarGender === 'female' ? 'selected' : ''}"
                                onclick={() => selectAvatarGender('female')}
                            >
                                여성
                            </button>
                        </div>
                    </div>

                    <div class="character-edit-row">
                        <span class="character-edit-label">캐릭터</span>
                        <div class="character-grid">
                            {#each [0, 1, 2, 3, 4, 5, 6, 7] as idx (idx)}
                                <button
                                    type="button"
                                    class="character-slot {selectedCharacterIndex === idx ? 'selected' : ''}"
                                    onclick={() => (selectedCharacterIndex = idx)}
                                    aria-label={`${selectedAvatarGender === 'male' ? '남성' : '여성'} 캐릭터 ${idx + 1}번 선택`}
                                    aria-pressed={selectedCharacterIndex === idx}
                                >
                                    <span
                                        class="character-sprite"
                                        style={`width: ${FRAME_WIDTH}px; height: ${FRAME_HEIGHT}px; ${spriteStyle(idx, selectedAvatarGender)}`}
                                    ></span>
                                </button>
                            {/each}
                        </div>
                    </div>

                    <div class="character-edit-buttons">
                        <button
                            type="button"
                            class="btn btn-primary"
                            onclick={saveCharacter}
                            disabled={isUpdatingCharacter}
                        >
                            {isUpdatingCharacter ? '저장 중...' : '저장'}
                        </button>
                        <button
                            type="button"
                            class="btn"
                            onclick={cancelEditCharacter}
                            disabled={isUpdatingCharacter}
                        >
                            취소
                        </button>
                    </div>
                </div>
            {/if}

            <div class="lobby-body">
                <section class="section players-section">
                    <h2 class="section-title">참가자 ({players.length}/{room.max_players})</h2>
                    {#if isHost}
                        <p class="hint-text">다른 참가자를 우클릭하거나 클릭하면 방장을 위임할 수 있습니다.</p>
                    {/if}

                    <ul class="player-list">
                        {#each sortedPlayers as p (p.id)}
                            <li class="player-list-item">
                                <div
                                    class="player-row {p.id === myPlayerId ? 'me' : ''} {canTransferTo(p) ? 'transferable' : ''}"
                                    role={canTransferTo(p) ? 'button' : undefined}
                                    tabindex={canTransferTo(p) ? 0 : undefined}
                                    aria-label={canTransferTo(p) ? `${p.nickname}님에게 방장 위임 메뉴 열기` : undefined}
                                    oncontextmenu={(event) => handlePlayerContextMenu(event, p)}
                                    onclick={(event) => handlePlayerClick(event, p)}
                                    onkeydown={(event) => {
                                        if (canTransferTo(p) && (event.key === 'Enter' || event.key === ' ')) {
                                            event.preventDefault();
                                            selectedTransferPlayerId = selectedTransferPlayerId === p.id ? null : p.id;
                                        }
                                    }}
                                >
                                    <span class="player-avatar">
                                        <span
                                            class="player-avatar-sprite"
                                            style={`width: ${FRAME_WIDTH}px; height: ${FRAME_HEIGHT}px; ${spriteStyle(p.character_index, p.avatar_gender)}`}
                                        ></span>
                                    </span>
                                    <span class="player-nickname">{p.nickname}</span>
                                    {#if p.is_host}
                                        <span class="host-badge">방장</span>
                                    {:else if p.is_ready}
                                        <span class="player-badge">준비완료</span>
                                    {/if}
                                    {#if p.connection_status === 'disconnected'}
                                        <span class="disconnected-badge">연결 끊김</span>
                                    {/if}
                                </div>

                                {#if selectedTransferPlayerId === p.id && canTransferTo(p)}
                                    <div class="inline-transfer-panel">
                                        <span>{p.nickname}님에게 방장 권한을 넘기시겠습니까?</span>
                                        <button
                                            type="button"
                                            class="btn btn-primary btn-sm"
                                            onclick={(event) => {
                                                event.stopPropagation();
                                                handleTransferFromInline(p);
                                            }}
                                            disabled={isTransferringHost}
                                        >
                                            {isTransferringHost ? '위임 중...' : '방장 위임'}
                                        </button>
                                    </div>
                                {/if}
                            </li>
                        {/each}
                    </ul>
                </section>

                <section class="section minigame-section">
                    <h2 class="section-title">미니게임 선택</h2>

                    {#if isHost}
                        <div class="minigame-panel">
                            <div class="minigame-detail">
                                {#if currentMinigame}
                                    <h3 class="minigame-detail-title">{currentMinigame.title}</h3>
                                    <p class="minigame-detail-desc">
                                        {currentMinigame.description ?? '설명이 없습니다.'}
                                    </p>
                                    <p class="minigame-detail-meta">총 {currentMinigame.question_count}문제 보유</p>
                                    {#if isChangingMinigame}
                                        <p class="minigame-detail-note">미니게임을 변경하는 중입니다...</p>
                                    {/if}
                                {:else}
                                    <p class="minigame-detail-placeholder">미니게임을 선택하세요.</p>
                                {/if}
                            </div>
                            <button
                                type="button"
                                class="minigame-picker-btn"
                                onclick={() => (isMinigamePickerOpen = true)}
                                disabled={isChangingMinigame}
                            >
                                다른 미니게임 전체보기
                            </button>
                        </div>
                    {:else if currentMinigame}
                        <div class="minigame-readonly-panel">
                            <h3 class="minigame-detail-title">{currentMinigame.title}</h3>
                            <p class="minigame-detail-desc">
                                {currentMinigame.description ?? '설명이 없습니다.'}
                            </p>
                            <p class="minigame-detail-meta">총 {currentMinigame.question_count}문제 보유</p>
                            <p class="minigame-detail-note">방장만 미니게임을 변경할 수 있습니다.</p>
                            <button
                                type="button"
                                class="minigame-picker-btn"
                                onclick={() => (isMinigamePickerOpen = true)}
                            >
                                미니게임 목록 보기
                            </button>
                        </div>
                    {:else}
                        <p class="status-text text-center">방장이 미니게임을 아직 선택하지 않았습니다.</p>
                    {/if}
                </section>
            </div>

            <footer class="lobby-footer">
                <button type="button" class="btn leave-btn" onclick={handleLeaveRoom} disabled={isLeaving}>
                    {isLeaving ? '처리 중...' : isHost ? '방 나가기' : '방 나가기'}
                </button>
                {#if isHost}
                    <button
                        type="button"
                        class="btn btn-primary start-btn"
                        onclick={handleStartGame}
                        disabled={isStarting || !canStartGame}
                    >
                        {isStarting ? '시작 중...' : '게임 시작'}
                    </button>
                {:else}
                    <button
                        type="button"
                        class="btn btn-primary start-btn ready-btn {myIsReady ? 'is-ready' : ''}"
                        onclick={handleToggleReady}
                        disabled={isTogglingReady}
                    >
                        {isTogglingReady ? '처리 중...' : myIsReady ? '준비 취소' : '준비'}
                    </button>
                {/if}
            </footer>
        {/if}
    </div>

    {#if contextMenu}
        <div
            class="context-menu"
            style={`left: ${contextMenu.x}px; top: ${contextMenu.y}px;`}
            role="menu"
            onclick={(event) => event.stopPropagation()}
            oncontextmenu={(event) => event.stopPropagation()}
        >
            <button type="button" role="menuitem" onclick={handleTransferFromContextMenu} disabled={isTransferringHost}>
                {contextMenu.nickname}님에게 방장 위임
            </button>
        </div>
    {/if}

    {#if room}
        <MinigamePickerModal
            bind:open={isMinigamePickerOpen}
            selectedMinigameId={room.minigame_id}
            minQuestionsRequired={MIN_QUESTIONS_REQUIRED}
            readOnly={!isHost}
            onSelect={isHost
                ? (minigame) => {
                      handleSelectMinigame(minigame);
                      isMinigamePickerOpen = false;
                  }
                : undefined}
        />
    {/if}
</div>

<style>
    /*
      전체 배경: 화면을 채우되, 내부 콘텐츠는 고정 max-width.
      화면이 커지면 좌우 여백만 늘어난다.
    */
    .lobby-page {
        display: flex;
        align-items: flex-start;
        height: calc(100dvh - (var(--page-padding-y) * 2));
        min-height: 0;
        padding: 0;
        justify-content: center;
    }

    /*
      대기실 콘텐츠 전체: 고정 1040px.
      4K 에서도 FHD 와 동일한 폭으로 렌더링되고, 화면이 커지는 만큼은
      lobby-page 좌우 여백으로만 흡수된다.
    */
    .lobby-shell {
        width: 100%;
        max-width: 1040px;
    }

    .status-text {
        padding: 32px 0;
        color: var(--color-text-secondary);
    }

    .status-text.error {
        color: var(--color-error);
    }

    .lobby-header {
        margin-bottom: 26px;
    }

    .room-title {
        margin-bottom: 10px;
    }

    .room-meta-area {
        position: relative;
        width: 100%;
        min-height: 32px;
    }

    .room-meta-row {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 10px;
    }

    .room-code-badge {
        padding: 5px 13px;
        border-radius: 8px;
        background: var(--color-accent);
        color: var(--color-accent-text);
        font-size: 14px;
        font-weight: 900;
    }

    .meta-chip {
        padding: 5px 13px;
        border-radius: 8px;
        background: var(--color-surface-dark);
        color: var(--color-text-secondary);
        font-size: 14px;
        font-weight: 700;
    }

    .profile-actions {
        position: absolute;
        top: 50%;
        left: 0;
        z-index: 1;
        display: flex;
        gap: 7px;
        transform: translateY(-50%);
    }

    .btn-meta {
        padding: 5px 13px;
        border: none;
        border-radius: 8px;
        background: var(--color-surface-dark);
        color: var(--color-text-secondary);
        cursor: pointer;
        font-family: inherit;
        font-size: 14px;
        font-weight: 700;
        white-space: nowrap;
        transition: background 0.15s ease;
    }

    .btn-meta:hover {
        background: #4436b8;
    }

    .nickname-edit-panel-header,
    .character-edit-panel-header {
        display: flex;
        flex-direction: column;
        gap: 13px;
        max-width: 520px;
        margin: -8px auto 16px;
        padding: 16px;
        border: 1px solid var(--color-accent);
        border-radius: 8px;
        background: var(--color-surface-darker);
    }

    .character-edit-row {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .character-edit-label {
        color: var(--color-text-secondary);
        font-size: 14px;
        font-weight: 800;
    }

    .gender-row {
        display: flex;
        gap: 11px;
        padding: 8px;
    }

    .gender-btn {
        flex: 1;
        padding: 11px;
        border: 2px solid var(--color-surface-dark);
        border-radius: 10px;
        background: var(--color-surface-dark);
        color: var(--color-text-secondary);
        cursor: pointer;
        font-family: inherit;
        font-size: 16px;
        font-weight: 800;
        transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
    }

    .gender-btn.selected {
        border-color: var(--color-accent);
        background: var(--color-surface-darker);
        color: var(--color-accent);
    }

    .gender-btn:hover:not(:disabled) {
        background: var(--color-surface-darker);
    }

    /*
      캐릭터 그리드: 슬롯 높이 고정 70px. FHD/4K 동일 크기.
    */
    .character-grid {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        grid-auto-rows: 70px;
        gap: 8px;
    }

    .character-slot {
        position: relative;
        display: flex;
        width: 100%;
        height: 100%;
        align-items: flex-end;
        justify-content: center;
        box-sizing: border-box;
        overflow: hidden;
        padding: 0;
        border: 2px solid var(--color-surface-dark);
        border-radius: 10px;
        background: var(--color-surface-darker);
        cursor: pointer;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .character-slot.selected {
        border-color: var(--color-accent);
        box-shadow: 0 0 0 2px var(--color-accent);
    }

    .character-slot:hover:not(:disabled) {
        border-color: var(--color-accent);
    }

    .character-sprite {
        position: absolute;
        bottom: 2px;
        flex-shrink: 0;
        background-repeat: no-repeat;
        image-rendering: pixelated;
        transform: scale(1.2);
        transform-origin: bottom center;
    }

    .character-edit-buttons,
    .nickname-edit-buttons {
        display: flex;
        gap: 8px;
    }

    .character-edit-buttons button,
    .nickname-edit-buttons button {
        flex: 1;
        margin-top: 8px;
        padding: 8px 14px;
        font-size: 14px;
    }

    /*
      본문 레이아웃: 참가자 목록과 미니게임 패널을 좌우 2 열로 배치.
    */
    .lobby-body {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 24px;
        align-items: start;
    }

    .section-title {
        margin-bottom: 13px;
    }

    .hint-text {
        margin: -5px 0 10px;
        color: var(--color-text-muted);
        font-size: 12px;
    }

    /*
      참가자 리스트: 최대 높이 고정 360px. 4K 에서도 동일하게 스크롤 처리.
    */
    .player-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-height: 360px;
        margin: 0;
        padding: 0;
        overflow-y: auto;
        list-style: none;
    }

    .player-list-item {
        margin: 0;
        padding: 0;
    }

    .player-row {
        display: flex;
        align-items: center;
        gap: 11px;
        padding: 10px 13px;
        border: 2px solid transparent;
        border-radius: 8px;
        background: var(--color-surface-dark);
    }

    .player-row.me {
        border-color: var(--color-accent);
    }

    .player-row.transferable {
        cursor: pointer;
    }

    .player-row.transferable:hover,
    .player-row.transferable:focus-visible {
        border-color: var(--color-accent);
        outline: none;
        background: #30277c;
    }

    /*
      아바타: 고정 44px. 해상도 무관하게 항상 동일 크기.
    */
    .player-avatar {
        display: flex;
        width: 44px;
        height: 44px;
        flex-shrink: 0;
        align-items: flex-end;
        justify-content: center;
        overflow: visible;
        border-radius: 50%;
        background-color: var(--color-surface-darker);
    }

    .player-avatar-sprite {
        flex-shrink: 0;
        background-repeat: no-repeat;
        image-rendering: pixelated;
        transform: scale(0.9);
        transform-origin: bottom center;
    }

    .player-nickname {
        flex: 1;
        overflow: hidden;
        color: var(--color-text-primary);
        font-size: 16px;
        font-weight: 700;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .host-badge {
        padding: 3px 8px;
        border-radius: 6px;
        flex-shrink: 0;
        background: var(--color-accent);
        color: var(--color-accent-text);
        font-size: 12px;
        font-weight: 900;
    }

    /*
      player-badge: 방장이 아닌 참가자가 레디했을 때 host-badge와
      동일한 형태/크기로 표시되는 "준비완료" 뱃지. 색상만 구분되도록
      성공/초록 계열을 사용한다.
    */
    .player-badge {
        padding: 3px 8px;
        border-radius: 6px;
        flex-shrink: 0;
        background: #548fbf;
        color: #ffffff;
        font-size: 12px;
        font-weight: 900;
    }

    .disconnected-badge {
        padding: 3px 8px;
        border-radius: 6px;
        flex-shrink: 0;
        background: var(--color-disabled);
        color: var(--color-text-primary);
        font-size: 12px;
        font-weight: 700;
    }

    .inline-transfer-panel {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: 4px;
        padding: 7px 9px 7px 11px;
        border: 1px solid var(--color-accent);
        border-radius: 7px;
        background: var(--color-surface-darker);
        color: var(--color-text-secondary);
        font-size: 12px;
    }

    .inline-transfer-panel span {
        min-width: 0;
    }

    .btn-sm {
        padding: 6px 9px;
        font-size: 12px;
    }

    .inline-transfer-panel button {
        flex: 0 0 auto;
    }

    /*
      minigame-panel: 미니게임 요약(상세) + "미니게임 전체보기" 버튼을
      세로로 배치하는 컨테이너. 기존 인라인 리스트(minigame-list)는
      MinigamePickerModal 로 대체되어 더 이상 사용하지 않는다.
    */
    .minigame-panel {
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .minigame-detail {
        display: flex;
        min-width: 0;
        flex: 1;
        flex-direction: column;
        gap: 8px;
        padding: 16px;
        border-radius: 8px;
        background: var(--color-surface-darker);
    }

    .minigame-readonly-panel {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 18px;
        border-radius: 8px;
        background: var(--color-surface-darker);
    }

    .minigame-detail-desc {
        color: var(--color-text-secondary);
        font-size: 16px;
        line-height: 1.5;
    }

    .minigame-detail-meta {
        color: var(--color-accent);
        font-size: 14px;
        font-weight: 700;
    }

    .minigame-detail-note {
        margin-top: 3px;
        color: var(--color-text-muted);
        font-size: 12px;
    }

    .minigame-detail-placeholder {
        color: var(--color-text-muted);
        font-size: 16px;
    }

    .lobby-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-top: 26px;
    }

    .leave-btn {
        flex: 0 0 auto;
    }

    .start-btn {
        flex: 1;
    }

    .minigame-picker-btn {
        flex: 0 0 auto;
        padding: 9px 18px;
        border: 2px solid var(--color-accent);
        border-radius: 9px;
        background: transparent;
        color: var(--color-accent);
        cursor: pointer;
        font-size: 14px;
        font-weight: 800;
        white-space: nowrap;
    }

    .minigame-picker-btn:hover:not(:disabled) {
        background: rgba(255, 213, 74, 0.12);
    }

    .minigame-picker-btn:disabled {
        cursor: not-allowed;
        opacity: 0.5;
    }

    /*
      ready-btn: 참가자용 레디 버튼. 기본은 start-btn(.btn-primary)과
      동일한 강조색을 쓰고, 레디 상태(is-ready)일 때만 성공/초록 계열로
      바뀌어 "이미 준비됨"을 시각적으로 알려준다.
    */
    .ready-btn.is-ready {
        background: #548fbf;
        border-color: #548fbf;
        color: #ffffff;
    }

    /*
      컨텍스트 메뉴: 고정 px 크기. 해상도 영향 없음.
    */
    .context-menu {
        position: fixed;
        z-index: 500;
        min-width: 190px;
        padding: 6px;
        border: 2px solid var(--color-border);
        border-radius: 8px;
        background: #ffffff;
        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
    }

    .context-menu button {
        width: 100%;
        padding: 9px 11px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: #1a1440;
        cursor: pointer;
        font-family: inherit;
        font-size: 16px;
        font-weight: 700;
        text-align: left;
    }

    .context-menu button:hover:not(:disabled) {
        background: #e5e3ff;
        color: var(--color-surface-dark);
    }

    .context-menu button:disabled {
        cursor: not-allowed;
        opacity: 0.5;
    }

    /*
      브레이크포인트 1: 1024px 미만 (태블릿)
      2 열 레이아웃을 1 열로 전환. 카드 크기는 그대로 유지.
    */
    @media (max-width: 1024px) {
        .lobby-body {
            grid-template-columns: 1fr;
        }

        .room-meta-area {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
        }

        .profile-actions {
            position: static;
            order: 2;
            transform: none;
        }

        .room-meta-row {
            order: 1;
        }
    }

    /*
      브레이크포인트 2: 640px 미만 (모바일)
      캐릭터 슬롯 높이만 축소, 나머지는 고정값 유지.
    */
    @media (max-width: 640px) {
        .lobby-footer {
            flex-direction: column;
        }

        .leave-btn,
        .start-btn {
            width: 100%;
        }

        .character-grid {
            grid-template-columns: repeat(4, 1fr);
            grid-auto-rows: 60px;
        }

        .character-sprite {
            transform: scale(1);
        }
    }
</style>
