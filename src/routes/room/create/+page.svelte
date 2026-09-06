<!--
  src/routes/room/create/+page.svelte

  방 생성 페이지 — 미니게임 선택을 모달(MinigamePickerModal)로 전환

  변경 사항 (이번 수정)
  1. minigames, minigamesLoading, minigamesError, loadMinigames() 완전 제거.
     미니게임 데이터 조회는 이제 MinigamePickerModal 내부에서만 이루어진다.
  2. 첫 번째 사용 가능한 미니게임 자동 선택 로직 제거. 사용자가 모달에서
     직접 고르기 전까지 selectedMinigame 은 null 로 유지된다.
  3. selectedMinigame 을 배열에서 find() 하던 방식에서, 모달의 onSelect
     콜백이 넘겨주는 MinigameOption 객체를 그대로 $state 에 저장하는
     방식으로 변경. 이제 minigame-panel(리스트+상세) UI 대신 요약 카드 +
     "미니게임 전체보기" 버튼만 남는다.
-->
<script lang="ts">
    import { beforeNavigate, goto } from '$app/navigation';
    import MinigamePickerModal from '$lib/components/MinigamePickerModal.svelte';
    import { ensureAnonymousSession, supabase } from '$lib/supabaseClient';
    import { onMount } from 'svelte';

    type MinigameOption = {
        minigame_id: string;
        slug: string;
        title: string;
        description: string | null;
        answer_type: 'multiple_choice' | 'short_answer';
        question_count: number;
    };

    const TIME_LIMIT_OPTIONS = [15, 30, 60] as const;
    const MAX_PLAYERS_MIN = 1;
    const MAX_PLAYERS_MAX = 16;
    const MIN_QUESTIONS_REQUIRED = 5;
    const PLAYER_OPTIONS = Array.from(
        { length: MAX_PLAYERS_MAX - MAX_PLAYERS_MIN + 1 },
        (_, index) => index + MAX_PLAYERS_MIN
    );

    let title = $state('');
    let password = $state('');
    let selectedMinigame = $state<MinigameOption | null>(null);
    let isPickerOpen = $state(false);
    let sessionReady = $state(false);
    let sessionError = $state<string | null>(null);
    let totalRounds = $state<number | null>(null);
    let timeLimitSeconds = $state<15 | 30 | 60>(15);
    let maxPlayers = $state(MAX_PLAYERS_MAX);
    let isRoundMenuOpen = $state(false);
    let isMaxPlayerMenuOpen = $state(false);
    let isSubmitting = $state(false);
    let errorMessage = $state<string | null>(null);

    let createdRoomId = $state<string | null>(null);
    let hasNavigatedAway = $state(false);
    let isCleaningUp = $state(false);

    let selectedMinigameId = $derived(selectedMinigame?.minigame_id ?? null);

    let roundOptions = $derived.by(() => {
        if (!selectedMinigame) return [];
        const options: number[] = [];
        for (let value = MIN_QUESTIONS_REQUIRED; value <= selectedMinigame.question_count; value += 5) {
            options.push(value);
        }
        return options;
    });

    let isValid = $derived(
        sessionReady &&
        title.trim().length > 0 &&
        selectedMinigameId !== null &&
        totalRounds !== null &&
        maxPlayers >= MAX_PLAYERS_MIN &&
        maxPlayers <= MAX_PLAYERS_MAX
    );

    function selectMinigame(minigame: MinigameOption) {
        selectedMinigame = minigame;
        totalRounds = minigame.question_count >= MIN_QUESTIONS_REQUIRED ? MIN_QUESTIONS_REQUIRED : null;
        isRoundMenuOpen = false;
    }

    function selectRound(option: number) {
        totalRounds = option;
        isRoundMenuOpen = false;
    }

    function toggleRoundMenu() {
        isMaxPlayerMenuOpen = false;
        isRoundMenuOpen = !isRoundMenuOpen;
    }

    function toggleMaxPlayerMenu() {
        isRoundMenuOpen = false;
        isMaxPlayerMenuOpen = !isMaxPlayerMenuOpen;
    }

    function selectMaxPlayers(option: number) {
        maxPlayers = option;
        isMaxPlayerMenuOpen = false;
    }

    async function cleanupCreatedRoomIfNeeded() {
        if (!createdRoomId || hasNavigatedAway || isCleaningUp) return;

        isCleaningUp = true;
        try {
            await supabase.rpc('cancel_room', { p_room_id: createdRoomId });
        } catch (err) {
            console.warn('[create] 방 정리 실패:', err);
        } finally {
            isCleaningUp = false;
        }
    }

    async function handleSubmit(event: SubmitEvent) {
        event.preventDefault();
        if (!isValid || isSubmitting || selectedMinigameId === null || totalRounds === null) return;

        isSubmitting = true;
        errorMessage = null;

        try {
            await ensureAnonymousSession();

            const { data, error } = await supabase.rpc('create_room_draft', {
                p_title: title.trim(),
                p_password: password.trim() === '' ? null : password.trim(),
                p_max_players: maxPlayers,
                p_time_limit_seconds: timeLimitSeconds,
                p_total_rounds: totalRounds,
                p_minigame_id: selectedMinigameId
            });

            if (error) throw error;

            const row = Array.isArray(data) ? data[0] : data;
            if (!row) throw new Error('방 생성 응답이 비어 있습니다.');

            createdRoomId = row.room_id;
            hasNavigatedAway = true;
            goto(`/room/${row.room_code}/join?host=1`);
        } catch (err) {
            errorMessage = err instanceof Error ? err.message : String(err);
        } finally {
            isSubmitting = false;
        }
    }

    async function handleCancel() {
        await cleanupCreatedRoomIfNeeded();
        goto('/');
    }

    onMount(async () => {
        try {
            await ensureAnonymousSession();
            sessionReady = true;
        } catch (err) {
            sessionError = err instanceof Error ? err.message : String(err);
        }
    });

    beforeNavigate(() => {
        if (createdRoomId && !hasNavigatedAway) {
            void cleanupCreatedRoomIfNeeded();
        }
    });
</script>

<div class="create-page">
    <div class="form-shell">
        <h1 class="page-title text-center">방 만들기</h1>

        {#if sessionError}
            <p class="error-text session-error text-center">로그인 초기화에 실패했습니다: {sessionError}</p>
        {/if}

        <form class="create-form" onsubmit={handleSubmit}>
            <section class="field-group">
                <label class="field-label" for="title">방 제목</label>
                <input
                    id="title"
                    class="input"
                    type="text"
                    placeholder="방 제목을 입력하세요"
                    bind:value={title}
                    maxlength="40"
                    required
                />
            </section>

            <section class="field-group">
                <label class="field-label" for="password">비밀번호 (선택)</label>
                <input
                    id="password"
                    class="input"
                    type="password"
                    placeholder="비워두면 공개방으로 생성됩니다"
                    bind:value={password}
                    maxlength="20"
                />
            </section>

            <section class="field-group">
                <span class="field-label">미니게임 선택</span>

                {#if selectedMinigame}
                    <div class="minigame-summary-card">
                        <div class="summary-info">
                            <h3 class="summary-title">{selectedMinigame.title}</h3>
                            <p class="summary-desc">
                                {selectedMinigame.description ?? '설명이 등록되지 않은 미니게임입니다.'}
                            </p>
                            <p class="summary-count">문제 {selectedMinigame.question_count}개</p>
                        </div>
                        <button type="button" class="btn btn-outline" onclick={() => (isPickerOpen = true)}>
                            미니게임 전체보기
                        </button>
                    </div>
                {:else}
                    <button
                        type="button"
                        class="btn btn-outline full-width"
                        onclick={() => (isPickerOpen = true)}
                    >
                        미니게임 전체보기에서 선택하기
                    </button>
                {/if}
            </section>

            <div class="settings-row">
                <section class="field-group">
                    <span class="field-label">제한 시간</span>
                    <div class="option-row">
                        {#each TIME_LIMIT_OPTIONS as option (option)}
                            <button
                                type="button"
                                class="option-btn {timeLimitSeconds === option ? 'selected' : ''}"
                                onclick={() => (timeLimitSeconds = option)}
                            >
                                {option}초
                            </button>
                        {/each}
                    </div>
                </section>

                <section class="field-group">
                    <span class="field-label">라운드 수</span>
                    <div class="round-dropdown">
                        <button
                            type="button"
                            class="round-trigger"
                            disabled={selectedMinigameId === null || roundOptions.length === 0}
                            aria-haspopup="listbox"
                            aria-expanded={isRoundMenuOpen}
                            onclick={toggleRoundMenu}
                        >
                            <span>
                                {totalRounds === null
                                    ? selectedMinigameId === null
                                        ? '게임 선택 필요'
                                        : '라운드 수 선택'
                                    : `${totalRounds}라운드`}
                            </span>
                            <span class="round-arrow">{isRoundMenuOpen ? '▲' : '▼'}</span>
                        </button>

                        {#if isRoundMenuOpen}
                            <ul class="round-menu" role="listbox" aria-label="라운드 수 선택">
                                {#each roundOptions as option (option)}
                                    <li>
                                        <button
                                            type="button"
                                            class:selected={totalRounds === option}
                                            onclick={() => selectRound(option)}
                                        >
                                            {option}라운드
                                        </button>
                                    </li>
                                {/each}
                            </ul>
                        {/if}
                    </div>
                </section>

                <section class="field-group">
                    <span class="field-label">최대 인원</span>
                    <div class="round-dropdown">
                        <button
                            type="button"
                            class="round-trigger"
                            aria-haspopup="listbox"
                            aria-expanded={isMaxPlayerMenuOpen}
                            onclick={toggleMaxPlayerMenu}
                        >
                            <span>{maxPlayers}명</span>
                            <span class="round-arrow">{isMaxPlayerMenuOpen ? '▲' : '▼'}</span>
                        </button>

                        {#if isMaxPlayerMenuOpen}
                            <ul class="round-menu" role="listbox" aria-label="최대 인원 선택">
                                {#each PLAYER_OPTIONS as option (option)}
                                    <li>
                                        <button
                                            type="button"
                                            class:selected={maxPlayers === option}
                                            onclick={() => selectMaxPlayers(option)}
                                        >
                                            {option}명
                                        </button>
                                    </li>
                                {/each}
                            </ul>
                        {/if}
                    </div>
                </section>
            </div>

            {#if errorMessage}
                <p class="error-text form-error text-center">방 생성에 실패했습니다: {errorMessage}</p>
            {/if}

            <div class="button-row">
                <button type="button" class="btn cancel-btn" onclick={handleCancel} disabled={isSubmitting}>
                    취소
                </button>
                <button type="submit" class="btn btn-primary submit-btn" disabled={!isValid || isSubmitting}>
                    {isSubmitting ? '생성 중...' : '방 만들기'}
                </button>
            </div>
        </form>
    </div>
</div>

<MinigamePickerModal
    bind:open={isPickerOpen}
    selectedMinigameId={selectedMinigameId}
    minQuestionsRequired={MIN_QUESTIONS_REQUIRED}
    onSelect={(minigame) => {
        selectMinigame(minigame);
        isPickerOpen = false;
    }}
/>

<style>
    /*
      create-page: 뷰포트 경계만 정의한다. page-container 의 상하 패딩(40px)만큼
      뺀 나머지 공간을 이 페이지가 차지하며, 그 안에서 세로 중앙 정렬한다.
    */
    .create-page {
        display: flex;
        align-items: flex-start;
        justify-content: center;
        box-sizing: border-box;
        height: calc(100dvh - (var(--page-padding-y) * 2));
        min-height: 0;
        padding: 0;
        overflow: hidden;
    }

    .form-shell {
        display: flex;
        flex-direction: column;
        width: 100%;
        max-width: 620px;
        max-height: 100%;
        min-height: 0;
    }

    .page-title {
        flex: 0 0 auto;
        margin-bottom: 12px;
    }

    .session-error {
        flex: 0 0 auto;
        margin-bottom: 12px;
    }

    .create-form {
        display: flex;
        flex-direction: column;
        gap: 14px;
        min-height: 0;
        padding: 20px 24px;
        border: 2px solid var(--color-border);
        border-radius: 14px;
        background: var(--color-surface);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    }

    .field-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 0;
        flex: 0 0 auto;
    }

    .field-label {
        color: var(--color-text-secondary);
        font-size: 15px;
        font-weight: 800;
    }

    .hint-text,
    .error-text {
        margin: 0;
        font-size: 14px;
    }

    .hint-text {
        color: var(--color-text-muted);
    }

    .error-text {
        color: var(--color-error);
        font-weight: 700;
    }

    .form-error {
        overflow-wrap: anywhere;
    }

    input[type='text'],
    input[type='password'],
    .round-trigger {
        width: 100%;
        height: 44px;
        padding: 7px 14px;
        border: none;
        border-radius: 9px;
        background: #fff;
        color: #1a1440;
        font-family: inherit;
        font-size: 15px;
        box-sizing: border-box;
    }

    input::placeholder {
        color: #a3a3a3;
    }

    .round-trigger:disabled {
        background: #d8d4ff;
        color: #6b64a8;
        cursor: not-allowed;
    }

    /* 미니게임 요약 카드 + 전체보기 버튼 */
    .minigame-summary-card {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        padding: 14px;
        border: 2px solid var(--color-border);
        border-radius: 11px;
        background: var(--color-surface-dark);
    }

    .summary-info {
        min-width: 0;
        flex: 1;
    }

    .summary-title {
        margin: 0 0 4px;
        overflow: hidden;
        color: var(--color-text-primary);
        font-size: 16px;
        font-weight: 900;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .summary-desc {
        display: -webkit-box;
        margin: 0 0 4px;
        overflow: hidden;
        color: var(--color-text-secondary);
        font-size: 13px;
        line-height: 1.3;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 1;
    }

    .summary-count {
        margin: 0;
        color: var(--color-accent);
        font-size: 13px;
        font-weight: 700;
    }

    .btn-outline {
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

    .btn-outline:hover {
        background: rgba(255, 213, 74, 0.12);
    }

    .btn-outline.full-width {
        width: 100%;
        height: 62px;
        text-align: center;
    }

    .settings-row {
        position: relative;
        z-index: 20;
        display: grid;
        grid-template-columns: repeat(1, minmax(0, 1fr));
        gap: 14px;
        flex: 0 0 auto;
    }

    .option-row {
        display: flex;
        height: 44px;
        gap: 7px;
    }

    .option-btn {
        flex: 1;
        min-width: 0;
        padding: 6px;
        border: 2px solid var(--color-surface-dark);
        border-radius: 9px;
        background: var(--color-surface-dark);
        color: var(--color-text-secondary);
        cursor: pointer;
        font-size: 15px;
        font-weight: 800;
    }

    .option-btn.selected {
        border-color: var(--color-accent);
        background: var(--color-accent);
        color: var(--color-accent-text);
    }

    .option-btn:hover:not(.selected) {
        border-color: #6a5cf0;
    }

    .round-dropdown {
        position: relative;
        z-index: 30;
        width: 100%;
    }

    .round-trigger {
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
        text-align: left;
    }

    .round-arrow {
        flex: 0 0 auto;
        margin-left: 6px;
        color: var(--color-surface);
        font-size: 11px;
    }

    .round-menu {
        position: absolute;
        right: 0;
        bottom: calc(100% + 7px);
        left: 0;
        z-index: 100;
        max-height: 220px;
        margin: 0;
        padding: 5px;
        overflow-y: auto;
        list-style: none;
        border: 2px solid var(--color-border);
        border-radius: 9px;
        background: #fff;
        box-shadow: 0 -6px 18px rgba(0, 0, 0, 0.32);
    }

    .round-menu li {
        margin: 0;
    }

    .round-menu button {
        box-sizing: border-box;
        width: 100%;
        padding: 8px 10px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: #1a1440;
        cursor: pointer;
        font-family: inherit;
        font-size: 15px;
        text-align: left;
    }

    .round-menu button:hover,
    .round-menu button.selected {
        background: #e5e3ff;
        color: var(--color-surface-dark);
        font-weight: 800;
    }

    .button-row {
        display: flex;
        flex: 0 0 auto;
        gap: 13px;
        margin-top: 2px;
    }

    .cancel-btn,
    .submit-btn {
        height: 46px;
    }

    .cancel-btn {
        flex: 1;
    }

    .submit-btn {
        flex: 2;
    }

    @media (max-height: 760px) {
        .create-form {
            gap: 11px;
            padding: 16px 22px;
        }
    }

    @media (max-width: 620px) {
        .create-page {
            height: auto;
            min-height: calc(100dvh - (var(--page-padding-y) * 2));
            overflow: visible;
        }

        .form-shell {
            max-height: none;
        }

        .page-title {
            font-size: 24px;
        }

        .create-form {
            gap: 16px;
            padding: 16px;
        }

        .minigame-summary-card {
            flex-direction: column;
            align-items: stretch;
        }

        .settings-row {
            gap: 7px;
        }

        .option-row {
            gap: 3px;
        }

        .option-btn {
            padding: 4px 2px;
            font-size: 12px;
        }

        .round-menu {
            max-height: 180px;
        }
    }
</style>
