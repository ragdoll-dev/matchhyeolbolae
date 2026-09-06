<!--
  src/routes/+page.svelte

  메인 홈 화면 — 맞혀볼래 — 마추기(machugi.io) 방식 반응형 원칙 적용

  적용 원칙
  1. 세로 방향 요소(카드 높이, 정보 바 높이, 로고 높이, 버튼 높이)는 rem 유동값 대신 고정 px
  2. content-zone 에 max-width 고정, 화면이 커지면 좌우 여백만 증가
     (마추기의 headerContainer/QuizMainList가 1200px max-width + 좌우 여백 확장과 동일 원칙)
  3. clamp() 사용하지 않음, 열 개수만 바뀌는 이산적 브레이크포인트 유지
  4. 4K 에서도 FHD 와 동일한 카드 크기로 렌더링, 카드 개수/여백만 조정됨
  - 방 제목이 길어도 4 열 카드 그리드의 열 너비가 깨지지 않도록 유지
-->
<script lang="ts">
    import { goto } from '$app/navigation';
    import {
        fetchRoomList,
        subscribeToRoomListChanges,
        unsubscribeFromRoomList,
        type RoomListRow
    } from '$lib/roomListRealtime';
    import type { RealtimeChannel } from '@supabase/supabase-js';
    import { onDestroy, onMount } from 'svelte';

    let rooms = $state<RoomListRow[]>([]);
    let searchKeyword = $state('');
    let isLoading = $state(true);
    let loadError = $state<string | null>(null);
    let channel: RealtimeChannel | null = null;

    let filteredRooms = $derived(
        searchKeyword.trim() === ''
            ? rooms
            : rooms.filter((room) =>
                  room.title.toLowerCase().includes(searchKeyword.trim().toLowerCase())
              )
    );

    async function refreshRoomList() {
        try {
            rooms = await fetchRoomList();
            loadError = null;
        } catch (err) {
            loadError = err instanceof Error ? err.message : String(err);
        } finally {
            isLoading = false;
        }
    }

    function statusLabel(status: RoomListRow['status']): string {
        return status === 'waiting' ? 'WAITING' : status === 'playing' ? 'PLAYING' : 'FINISHED';
    }

    function isEnterable(room: RoomListRow): boolean {
        return room.status === 'waiting' && room.current_players < room.max_players;
    }

    function handleEnterRoom(room: RoomListRow) {
        if (!isEnterable(room)) return;
        goto(`/room/${room.code}/join`);
    }

    function handleCreateRoom() {
        goto('/room/create');
    }

    onMount(() => {
        refreshRoomList();
        channel = subscribeToRoomListChanges(refreshRoomList);
    });

    onDestroy(() => {
        if (channel) unsubscribeFromRoomList(channel);
    });
</script>

<div class="main-page">
    <header class="top-bar">
        <img src="/logo.png" alt="맞혀볼래" class="logo-img" />
    </header>

    <div class="content-zone">
        <div class="search-row">
            <div class="search-bar">
                <input
                    class="input"
                    type="text"
                    placeholder="방 제목으로 검색"
                    bind:value={searchKeyword}
                    aria-label="방 제목 검색"
                />
                <span class="search-icon">🔍</span>
            </div>
            <button class="btn btn-primary create-btn" onclick={handleCreateRoom}>방 만들기</button>
        </div>

        <main class="page-content">
            {#if isLoading}
                <p class="status-text text-center">방 목록을 불러오는 중...</p>
            {:else if loadError}
                <p class="status-text error text-center">방 목록을 불러오지 못했습니다: {loadError}</p>
            {:else if filteredRooms.length === 0}
                <p class="status-text text-center">
                    {searchKeyword ? '검색 결과가 없습니다.' : '현재 생성된 방이 없습니다. 방을 만들어보세요!'}
                </p>
            {:else}
                <ul class="room-grid">
                    {#each filteredRooms as room (room.room_id)}
                        <li>
                            <button
                                class="room-card {isEnterable(room) ? 'enterable' : 'disabled'}"
                                onclick={() => handleEnterRoom(room)}
                                disabled={!isEnterable(room)}
                            >
                                <div class="room-info-bar">
                                    <span class="room-code">{room.code}</span>
                                    <span class="room-title" title={room.title}>{room.title}</span>
                                    {#if room.has_password}
                                        <span class="lock-icon" title="비밀번호 방">🔒</span>
                                    {/if}
                                </div>

                                <div class="room-status-row">
                                    <span class="status-badge {room.status}">{statusLabel(room.status)}</span>
                                    <span class="player-count">{room.current_players}/{room.max_players}</span>
                                </div>

                                <div class="minigame-bar" title={room.minigame_title ?? '미니게임 미선택'}>
                                    {room.minigame_title ?? '미니게임 미선택'}
                                </div>
                            </button>
                        </li>
                    {/each}
                </ul>
            {/if}
        </main>
    </div>
</div>

<style>
    .main-page {
        display: flex;
        flex-direction: column;
        min-height: 100vh;
    }

    .top-bar {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 13px 0;
    }

    /*
      로고: 고정 px 높이. FHD/QHD/4K 모두 동일 크기.
    */
    .logo-img {
        width: auto;
        height: 72px;
        filter: brightness(0) invert(1);
    }

    /*
      콘텐츠 영역: 고정 max-width. 화면이 커지면 좌우 여백만 증가한다.
      마추기의 QuizMainList가 max-width:1200px 에서 1050px 로 단계적으로만
      줄어드는 것과 동일한 원칙 — 절대 100% 로 풀지 않는다.
    */
    .content-zone {
        flex: 1;
        width: 100%;
        max-width: 1280px;
        margin: 0 auto;
        padding: 0 24px 64px;
        box-sizing: border-box;
    }

    .search-row {
        display: flex;
        align-items: center;
        margin-bottom: 48px;
    }

    .search-bar {
        position: relative;
        min-width: 0;
        flex: 1;
    }

    .search-bar input {
        width: 100%;
    }

    .search-icon {
        position: absolute;
        top: 50%;
        right: 16px;
        transform: translateY(-50%);
        opacity: 0.5;
        font-size: 19px;
    }

    .create-btn {
        flex: 0 0 auto;
        margin-left: 13px;
        padding: 14px 22px;
        white-space: nowrap;
    }

    .page-content {
        width: 100%;
    }

    .status-text {
        padding: 48px 0;
        color: var(--color-text-secondary);
    }

    .status-text.error {
        color: var(--color-error);
    }

    /*
      카드 그리드: 열 개수만 화면 크기에 따라 바뀐다.
      각 카드의 내부 크기(높이, 폭)는 fr 단위로 열을 나누되,
      세로 요소(높이, 정보 바 높이)는 전부 고정 px 로 통일했다.
      minmax(0, 1fr) 과 li 의 min-width: 0 이 긴 제목에 의한 열 확장을 막는다.
    */
    .room-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 40px;
        width: 100%;
        margin: 0;
        padding: 0;
        list-style: none;
    }

    .room-grid > li {
        width: 100%;
        min-width: 0;
    }

    /*
      카드 높이: 고정 140px. 4K 에서도 FHD 와 완전히 동일한 카드 높이.
      화면이 커지면 카드 폭(fr)만 넓어지고, 높이와 내부 바 높이는 절대 변하지 않는다.
    */
    .room-card {
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        height: 140px;
        padding: 0;
        overflow: hidden;
        border: 2px solid var(--color-border);
        border-radius: 10px;
        background: var(--color-surface);
        box-shadow: 0 3px 8px rgba(0, 0, 0, 0.25);
        font-family: inherit;
        text-align: left;
    }

    .room-card.enterable {
        cursor: pointer;
        transition: box-shadow 0.15s ease, transform 0.1s ease;
    }

    .room-card.enterable:hover {
        transform: translateY(-2px);
        box-shadow: 0 0 0 2px var(--color-accent), 0 8px 18px rgba(0, 0, 0, 0.35);
    }

    .room-card.disabled {
        cursor: not-allowed;
        background: #3a3160;
        opacity: 0.55;
    }

    .room-info-bar {
        display: flex;
        align-items: center;
        gap: 11px;
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        height: 48px;
        padding: 0 19px;
        overflow: hidden;
        background: #fff;
    }

    .room-code {
        flex: 0 0 auto;
        padding: 4px 10px;
        border-radius: 5px;
        background: var(--color-surface);
        color: #fff;
        font-size: 14px;
        font-weight: 900;
    }

    .room-title {
        min-width: 0;
        flex: 1 1 auto;
        overflow: hidden;
        color: #1a1440;
        font-size: 15px;
        font-weight: 800;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .lock-icon {
        flex: 0 0 auto;
        font-size: 15px;
    }

    .room-status-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        height: 42px;
        padding: 0 19px;
        background: var(--color-surface-dark);
    }

    .status-badge {
        padding: 5px 11px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 900;
        letter-spacing: 0.02em;
    }

    .status-badge.waiting {
        background: #eae73f;
        color: #4a2e00;
    }

    .status-badge.playing {
        background: #ff6b81;
        color: #fff;
    }

    .status-badge.finished {
        background: var(--color-disabled);
        color: #fff;
    }

    .player-count {
        flex: 0 0 auto;
        color: #fff;
        font-size: 15px;
        font-weight: 800;
    }

    .minigame-bar {
        display: flex;
        align-items: center;
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        height: 46px;
        padding: 0 19px;
        overflow: hidden;
        background: var(--color-surface-darker);
        color: var(--color-text-secondary);
        font-size: 14px;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .room-card.disabled .minigame-bar {
        color: var(--color-text-muted);
    }

    /*
      브레이크포인트: 열 개수만 변경. 카드 높이·내부 바 높이는 전부 고정값 그대로 유지.
      마추기가 화면이 줄어들 때 "카드를 작게" 만들지 않고 "열 개수"만 줄이는 것과 동일.
    */
    @media (max-width: 1050px) {
        .room-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
        }
    }

    @media (max-width: 760px) {
        .content-zone {
            padding: 0 16px 48px;
        }

        .search-row {
            margin-bottom: 32px;
        }

        .room-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 16px;
        }
    }

    @media (max-width: 460px) {
        .content-zone {
            padding: 0 12px 40px;
        }

        .room-grid {
            grid-template-columns: minmax(0, 1fr);
        }
    }
</style>