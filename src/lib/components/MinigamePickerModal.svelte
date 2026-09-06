<!--
  src/lib/components/MinigamePickerModal.svelte

  미니게임 선택 모달 (공용 컴포넌트)
  - create 페이지, room 대기실 페이지에서 공통으로 사용
  - 검색(제목/설명), 정답 타입 필터, 카드 그리드 레이아웃
  - 선택 시 onSelect 콜백 호출 후 모달 닫힘

  사용 예:
  <MinigamePickerModal
      bind:open={isPickerOpen}
      selectedMinigameId={selectedMinigameId}
      minQuestionsRequired={MIN_QUESTIONS_REQUIRED}
      onSelect={(minigame) => { selectMinigame(minigame); isPickerOpen = false; }}
  />
-->
<script lang="ts">
    import { supabase } from '$lib/supabaseClient';

    type MinigameOption = {
        minigame_id: string;
        slug: string;
        title: string;
        description: string | null;
        answer_type: 'multiple_choice' | 'short_answer';
        question_count: number;
    };

    type AnswerTypeFilter = 'all' | 'multiple_choice' | 'short_answer';

    let {
        open = $bindable(false),
        selectedMinigameId = null,
        minQuestionsRequired = 5,
        onSelect
    }: {
        open: boolean;
        selectedMinigameId: string | null;
        minQuestionsRequired?: number;
        onSelect: (minigame: MinigameOption) => void;
    } = $props();

    let minigames = $state<MinigameOption[]>([]);
    let isLoading = $state(true);
    let loadError = $state<string | null>(null);
    let searchQuery = $state('');
    let answerTypeFilter = $state<AnswerTypeFilter>('all');
    let hasLoadedOnce = $state(false);

    let filteredMinigames = $derived.by(() => {
        const query = searchQuery.trim().toLowerCase();

        return minigames.filter((minigame) => {
            if (answerTypeFilter !== 'all' && minigame.answer_type !== answerTypeFilter) {
                return false;
            }

            if (query.length === 0) return true;

            const titleMatch = minigame.title.toLowerCase().includes(query);
            const descMatch = (minigame.description ?? '').toLowerCase().includes(query);
            return titleMatch || descMatch;
        });
    });

    async function loadMinigames() {
        isLoading = true;
        loadError = null;

        try {
            const { data, error } = await supabase
                .from('minigames_with_question_count')
                .select('minigame_id, slug, title, description, answer_type, question_count')
                .order('title');

            if (error) throw error;
            minigames = (data ?? []) as MinigameOption[];
            hasLoadedOnce = true;
        } catch (err) {
            loadError = err instanceof Error ? err.message : String(err);
        } finally {
            isLoading = false;
        }
    }

    function handleSelect(minigame: MinigameOption) {
        if (minigame.question_count < minQuestionsRequired) return;
        onSelect(minigame);
    }

    function closeModal() {
        open = false;
    }

    function handleBackdropClick(event: MouseEvent) {
        if (event.target === event.currentTarget) closeModal();
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') closeModal();
    }

    $effect(() => {
        if (open) {
            answerTypeFilter = 'all';
            searchQuery = '';
            if (!hasLoadedOnce) {
                void loadMinigames();
            }
        }
    });
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
    <div class="modal-backdrop" onclick={handleBackdropClick} role="presentation">
        <div class="modal-shell" role="dialog" aria-modal="true" aria-label="미니게임 전체보기">
            <header class="modal-header">
                <h2 class="modal-title">미니게임 전체보기</h2>
                <button type="button" class="modal-close-btn" onclick={closeModal} aria-label="닫기">
                    ✕
                </button>
            </header>

            <div class="modal-controls">
                <input
                    class="search-input"
                    type="text"
                    placeholder="미니게임 제목 또는 설명으로 검색"
                    bind:value={searchQuery}
                />

                <div class="filter-row">
                    <button
                        type="button"
                        class="filter-btn {answerTypeFilter === 'all' ? 'selected' : ''}"
                        onclick={() => (answerTypeFilter = 'all')}
                    >
                        전체
                    </button>
                    <button
                        type="button"
                        class="filter-btn {answerTypeFilter === 'short_answer' ? 'selected' : ''}"
                        onclick={() => (answerTypeFilter = 'short_answer')}
                    >
                        주관식
                    </button>
                    <button
                        type="button"
                        class="filter-btn {answerTypeFilter === 'multiple_choice' ? 'selected' : ''}"
                        onclick={() => (answerTypeFilter = 'multiple_choice')}
                    >
                        객관식
                    </button>
                </div>
            </div>

            <div class="modal-body">
                {#if isLoading}
                    <p class="status-text text-center">미니게임 목록을 불러오는 중...</p>
                {:else if loadError}
                    <p class="status-text error text-center">미니게임 목록을 불러오지 못했습니다: {loadError}</p>
                {:else if filteredMinigames.length === 0}
                    <p class="status-text text-center">
                        {searchQuery.trim().length > 0 || answerTypeFilter !== 'all'
                            ? '조건에 맞는 미니게임이 없습니다.'
                            : '등록된 미니게임이 없습니다.'}
                    </p>
                {:else}
                    <div class="minigame-grid">
                        {#each filteredMinigames as minigame (minigame.minigame_id)}
                            {@const disabled = minigame.question_count < minQuestionsRequired}
                            <button
                                type="button"
                                class="minigame-card {selectedMinigameId === minigame.minigame_id ? 'selected' : ''} {disabled ? 'disabled' : ''}"
                                onclick={() => handleSelect(minigame)}
                                disabled={disabled}
                            >
                                <div class="card-header">
                                    <span class="card-title">{minigame.title}</span>
                                    <span class="card-answer-type">
                                        {minigame.answer_type === 'short_answer' ? '주관식' : '객관식'}
                                    </span>
                                </div>
                                <p class="card-description">
                                    {minigame.description ?? '설명이 등록되지 않은 미니게임입니다.'}
                                </p>
                                <div class="card-footer">
                                    <span class="card-question-count">문제 {minigame.question_count}개</span>
                                    {#if disabled}
                                        <span class="card-warning">최소 {minQuestionsRequired}개 필요</span>
                                    {/if}
                                </div>
                            </button>
                        {/each}
                    </div>
                {/if}
            </div>
        </div>
    </div>
{/if}

<style>
    .modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(10, 10, 20, 0.6);
    }

    .modal-shell {
        display: flex;
        flex-direction: column;
        width: 100%;
        max-width: 960px;
        height: min(80vh, 720px);
        box-sizing: border-box;
        overflow: hidden;
        border: 2px solid var(--color-border);
        border-radius: 16px;
        background: var(--color-surface);
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
    }

    .modal-header {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: space-between;
        padding: 18px 22px;
        border-bottom: 2px solid var(--color-border);
    }

    .modal-title {
        margin: 0;
        color: var(--color-text-primary);
        font-size: 20px;
        font-weight: 900;
    }

    .modal-close-btn {
        display: flex;
        width: 32px;
        height: 32px;
        align-items: center;
        justify-content: center;
        border: none;
        border-radius: 8px;
        background: var(--color-surface-dark);
        color: var(--color-text-secondary);
        cursor: pointer;
        font-size: 16px;
        font-weight: 900;
    }

    .modal-close-btn:hover {
        background: var(--color-surface-darker);
    }

    .modal-controls {
        display: flex;
        flex: 0 0 auto;
        flex-direction: column;
        gap: 10px;
        padding: 16px 22px;
        border-bottom: 2px solid var(--color-border);
    }

    .search-input {
        box-sizing: border-box;
        width: 100%;
        height: 42px;
        padding: 7px 14px;
        border: none;
        border-radius: 9px;
        background: #fff;
        color: #1a1440;
        font-family: inherit;
        font-size: 15px;
    }

    .search-input::placeholder {
        color: #a3a3a3;
    }

    .filter-row {
        display: flex;
        gap: 7px;
    }

    .filter-btn {
        padding: 6px 16px;
        border: 2px solid var(--color-surface-dark);
        border-radius: 9px;
        background: var(--color-surface-dark);
        color: var(--color-text-secondary);
        cursor: pointer;
        font-size: 14px;
        font-weight: 800;
    }

    .filter-btn.selected {
        border-color: var(--color-accent);
        background: var(--color-accent);
        color: var(--color-accent-text);
    }

    .filter-btn:hover:not(.selected) {
        border-color: #6a5cf0;
    }

    .modal-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        padding: 18px 22px;
    }

    .status-text {
        padding: 48px 0;
        color: var(--color-text-secondary);
    }

    .status-text.error {
        color: var(--color-error);
    }

    .minigame-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 14px;
    }

    .minigame-card {
        display: flex;
        flex-direction: column;
        gap: 8px;
        box-sizing: border-box;
        padding: 14px;
        border: 2px solid var(--color-border);
        border-radius: 12px;
        background: var(--color-surface-dark);
        cursor: pointer;
        text-align: left;
    }

    .minigame-card.selected {
        border-color: var(--color-accent);
        background: var(--color-surface-darker);
    }

    .minigame-card.disabled {
        cursor: not-allowed;
        opacity: 0.45;
    }

    .minigame-card:hover:not(.selected):not(.disabled) {
        border-color: var(--color-disabled);
    }

    .card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }

    .card-title {
        overflow: hidden;
        color: var(--color-text-primary);
        font-size: 16px;
        font-weight: 900;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .card-answer-type {
        flex: 0 0 auto;
        padding: 3px 8px;
        border-radius: 6px;
        background: var(--color-surface);
        color: var(--color-text-secondary);
        font-size: 12px;
        font-weight: 800;
        white-space: nowrap;
    }

    .card-description {
        display: -webkit-box;
        margin: 0;
        overflow: hidden;
        color: var(--color-text-secondary);
        font-size: 14px;
        line-height: 1.4;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
    }

    .card-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: auto;
    }

    .card-question-count {
        color: var(--color-accent);
        font-size: 13px;
        font-weight: 700;
    }

    .card-warning {
        color: var(--color-error);
        font-size: 11px;
        font-weight: 700;
    }

    @media (max-width: 640px) {
        .modal-backdrop {
            padding: 12px;
        }

        .modal-shell {
            height: min(88vh, 720px);
        }

        .modal-header,
        .modal-controls,
        .modal-body {
            padding-right: 14px;
            padding-left: 14px;
        }

        .minigame-grid {
            grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
            gap: 10px;
        }
    }
</style>
