<!--
  src/routes/minigames/create/+page.svelte

  사용자 미니게임 생성 페이지 v3
  - 최소 라운드: 최대 라운드와 같은 round-trigger UI, 5라운드 고정/비활성화
  - 최대 라운드: 10/15/20/25/30 드롭다운 선택 (기본 30)
  - 정답 타입: 주관식 / 객관식
  - 문제 목록 전체 페이지 스크롤 허용
-->
<script lang="ts">
    import { goto } from '$app/navigation';
    import { ensureAnonymousSession, supabase } from '$lib/supabaseClient';
    import { onMount } from 'svelte';

    type QuestionInput = {
        id: string;
        prompt: string;
        correct_answers: string | string[];
        choices?: string[];
    };

    const MIN_QUESTIONS_REQUIRED = 5;
    const MIN_ROUNDS_FIXED = 5;
    const MAX_ROUND_OPTIONS = [10, 15, 20, 25, 30] as const;
    const SLUG_PATTERN = /^[a-z0-9-]{3,50}$/;

    let title = $state('');
    let slug = $state('');
    let description = $state('');
    let answerType = $state<'multiple_choice' | 'short_answer'>('short_answer');
    let maxRounds = $state<10 | 15 | 20 | 25 | 30>(30);

    let questions = $state<QuestionInput[]>([]);
    let sessionReady = $state(false);
    let sessionError = $state<string | null>(null);
    let isSubmitting = $state(false);
    let errorMessage = $state<string | null>(null);
    let isMaxRoundsMenuOpen = $state(false);

    let isValid = $derived(
        sessionReady &&
        title.trim().length > 0 &&
        SLUG_PATTERN.test(slug.trim()) &&
        questions.length >= MIN_QUESTIONS_REQUIRED &&
        questions.every((q) => q.prompt.trim().length > 0 && hasValidAnswer(q, answerType))
    );

    function hasValidAnswer(q: QuestionInput, type: string): boolean {
        if (type === 'short_answer') {
            const ans = Array.isArray(q.correct_answers) ? q.correct_answers[0] : q.correct_answers;
            return typeof ans === 'string' && ans.trim().length > 0;
        }
        return Array.isArray(q.choices) && q.choices.length >= 2 && q.choices.every((c) => c.trim().length > 0);
    }

    function addQuestion() {
        questions = [
            ...questions,
            {
                id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                prompt: '',
                correct_answers: answerType === 'short_answer' ? '' : [],
                choices: answerType === 'multiple_choice' ? ['', ''] : undefined
            }
        ];
    }

    function removeQuestion(id: string) {
        questions = questions.filter((q) => q.id !== id);
    }

    function toggleMaxRoundsMenu() {
        isMaxRoundsMenuOpen = !isMaxRoundsMenuOpen;
    }

    function selectMaxRounds(option: number) {
        maxRounds = option as 10 | 15 | 20 | 25 | 30;
        isMaxRoundsMenuOpen = false;
    }

    async function handleSubmit(event: SubmitEvent) {
        event.preventDefault();
        if (!isValid || isSubmitting) return;

        isSubmitting = true;
        errorMessage = null;

        try {
            await ensureAnonymousSession();

            const payload = questions.map((q) => ({
                prompt: q.prompt.trim(),
                correct_answers: answerType === 'short_answer'
                    ? (Array.isArray(q.correct_answers) ? q.correct_answers[0] : q.correct_answers)
                    : q.choices!,
                choices: answerType === 'multiple_choice' ? q.choices : undefined
            }));

            const { data: minigameId, error } = await supabase.rpc('create_minigame_with_questions', {
                p_title: title.trim(),
                p_slug: slug.trim(),
                p_description: description.trim(),
                p_answer_type: answerType,
                p_min_rounds: MIN_ROUNDS_FIXED,
                p_max_rounds: maxRounds,
                p_questions: payload
            });

            if (error) throw error;

            goto(`/minigames/${minigameId}`);
        } catch (err) {
            errorMessage = err instanceof Error ? err.message : String(err);
        } finally {
            isSubmitting = false;
        }
    }

    async function handleCancel() {
        goto('/minigames');
    }

    onMount(async () => {
        try {
            await ensureAnonymousSession();
            sessionReady = true;
        } catch (err) {
            sessionError = err instanceof Error ? err.message : String(err);
        }

        for (let i = 0; i < MIN_QUESTIONS_REQUIRED; i++) {
            addQuestion();
        }
    });
</script>

<div class="create-page">
    <div class="form-shell">
        <h1 class="page-title text-center">미니게임 만들기</h1>

        {#if sessionError}
            <p class="error-text session-error text-center">로그인 초기화에 실패했습니다: {sessionError}</p>
        {/if}

        <form class="create-form" onsubmit={handleSubmit}>
            <section class="field-group">
                <label class="field-label" for="title">미니게임 제목</label>
                <input
                    id="title"
                    class="input"
                    type="text"
                    placeholder="예: 초성퀴즈, 객관식 상식"
                    bind:value={title}
                    maxlength="60"
                    required
                />
            </section>

            <section class="field-group">
                <label class="field-label" for="slug">슬러그 (영문 소문자, 숫자, - 만 허용)</label>
                <input
                    id="slug"
                    class="input"
                    type="text"
                    placeholder="예: cho-seong-quiz, general-knowledge"
                    bind:value={slug}
                    maxlength="50"
                    pattern="[a-z0-9-]+"
                    required
                />
                <p class="hint-text">URL 에 사용되는 식별자입니다. 중복될 수 없습니다.</p>
            </section>

            <section class="field-group">
                <label class="field-label" for="description">설명 (선택)</label>
                <textarea
                    id="description"
                    class="input textarea"
                    placeholder="이 미니게임에 대한 간단한 설명을 입력하세요"
                    bind:value={description}
                    maxlength="500"
                    rows="3"
                ></textarea>
            </section>

            <section class="field-group">
                <span class="field-label">정답 타입</span>
                <div class="option-row">
                    <button
                        type="button"
                        class="option-btn {answerType === 'short_answer' ? 'selected' : ''}"
                        onclick={() => (answerType = 'short_answer')}
                    >
                        주관식
                    </button>
                    <button
                        type="button"
                        class="option-btn {answerType === 'multiple_choice' ? 'selected' : ''}"
                        onclick={() => (answerType = 'multiple_choice')}
                    >
                        객관식
                    </button>
                </div>
            </section>

            <div class="settings-row">
                <section class="field-group">
                    <span class="field-label">최소 라운드</span>
                    <div class="round-dropdown">
                        <button
                            type="button"
                            class="round-trigger"
                            disabled
                            tabindex="-1"
                        >
                            <span>{MIN_ROUNDS_FIXED}라운드 (고정)</span>
                            <span class="round-arrow">▼</span>
                        </button>
                    </div>
                    <p class="hint-text">최소 5문제 이상 등록해야 합니다.</p>
                </section>

                <section class="field-group">
                    <span class="field-label">최대 라운드</span>
                    <div class="round-dropdown">
                        <button
                            type="button"
                            class="round-trigger"
                            aria-haspopup="listbox"
                            aria-expanded={isMaxRoundsMenuOpen}
                            onclick={toggleMaxRoundsMenu}
                        >
                            <span>{maxRounds}라운드</span>
                            <span class="round-arrow">{isMaxRoundsMenuOpen ? '▲' : '▼'}</span>
                        </button>

                        {#if isMaxRoundsMenuOpen}
                            <ul class="round-menu" role="listbox" aria-label="최대 라운드 선택">
                                {#each MAX_ROUND_OPTIONS as option (option)}
                                    <li>
                                        <button
                                            type="button"
                                            class:selected={maxRounds === option}
                                            onclick={() => selectMaxRounds(option)}
                                        >
                                            {option}라운드
                                        </button>
                                    </li>
                                {/each}
                            </ul>
                        {/if}
                    </div>
                </section>
            </div>

            <section class="field-group">
                <div class="questions-header">
                    <span class="field-label">문제 목록 (최소 {MIN_QUESTIONS_REQUIRED}개 필요)</span>
                    <button type="button" class="btn btn-small" onclick={addQuestion}>
                        문제 추가
                    </button>
                </div>

                {#if questions.length < MIN_QUESTIONS_REQUIRED}
                    <p class="hint-text">
                        최소 {MIN_QUESTIONS_REQUIRED}개 이상의 문제를 추가해야 제출할 수 있습니다.
                        (현재 {questions.length}개)
                    </p>
                {/if}

                <div class="questions-list">
                    {#each questions as question, index (question.id)}
                        <div class="question-card">
                            <div class="question-header">
                                <span class="question-number">문제 {index + 1}</span>
                                {#if questions.length > MIN_QUESTIONS_REQUIRED}
                                    <button
                                        type="button"
                                        class="btn btn-danger btn-small"
                                        onclick={() => removeQuestion(question.id)}
                                    >
                                        삭제
                                    </button>
                                {/if}
                            </div>

                            <div class="question-field">
                                <label class="field-label">문제 지문</label>
                                <input
                                    class="input"
                                    type="text"
                                    placeholder="문제 내용을 입력하세요"
                                    bind:value={question.prompt}
                                    maxlength="500"
                                    required
                                />
                            </div>

                            {#if answerType === 'short_answer'}
                                <div class="question-field">
                                    <label class="field-label">정답</label>
                                    <input
                                        class="input"
                                        type="text"
                                        placeholder="정답을 입력하세요"
                                        bind:value={question.correct_answers}
                                        maxlength="200"
                                        required
                                    />
                                </div>
                            {:else}
                                <div class="question-field">
                                    <label class="field-label">보기 (최소 2개)</label>
                                    <div class="choices-list">
                                        {#each question.choices || [] as choice, choiceIndex (choiceIndex)}
                                            <div class="choice-row">
                                                <input
                                                    class="input"
                                                    type="text"
                                                    placeholder={`보기 ${choiceIndex + 1}`}
                                                    bind:value={question.choices![choiceIndex]}
                                                    maxlength="200"
                                                    required
                                                />
                                                {#if (question.choices?.length || 0) > 2}
                                                    <button
                                                        type="button"
                                                        class="btn btn-danger btn-small"
                                                        onclick={() => {
                                                            question.choices?.splice(choiceIndex, 1);
                                                            question.choices = [...(question.choices || [])];
                                                        }}
                                                    >
                                                        삭제
                                                    </button>
                                                {/if}
                                            </div>
                                        {/each}
                                        <button
                                            type="button"
                                            class="btn btn-small"
                                            onclick={() => {
                                                question.choices = [...(question.choices || []), ''];
                                            }}
                                        >
                                            보기 추가
                                        </button>
                                    </div>
                                </div>
                            {/if}
                        </div>
                    {/each}
                </div>
            </section>

            {#if errorMessage}
                <p class="error-text form-error text-center">미니게임 생성에 실패했습니다: {errorMessage}</p>
            {/if}

            <div class="button-row">
                <button type="button" class="btn cancel-btn" onclick={handleCancel} disabled={isSubmitting}>
                    취소
                </button>
                <button type="submit" class="btn btn-primary submit-btn" disabled={!isValid || isSubmitting}>
                    {isSubmitting ? '생성 중...' : '미니게임 만들기'}
                </button>
            </div>
        </form>
    </div>
</div>

<style>
    .create-page {
        display: flex;
        align-items: flex-start;
        justify-content: center;
        box-sizing: border-box;
        height: auto;
        min-height: calc(100dvh - (var(--page-padding-y) * 2));
        padding: 0;
        overflow: visible;
    }

    .form-shell {
        display: flex;
        flex-direction: column;
        width: 100%;
        max-width: 720px;
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
        padding: 20px 24px;
        border: 2px solid var(--color-border);
        border-radius: 14px;
        background: var(--color-surface);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    }

    .field-group {
        display: flex;
        flex: 0 0 auto;
        flex-direction: column;
        min-width: 0;
        gap: 8px;
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
    .textarea {
        box-sizing: border-box;
        width: 100%;
        padding: 7px 14px;
        border: none;
        border-radius: 9px;
        background: #fff;
        color: #1a1440;
        font-family: inherit;
        font-size: 15px;
    }

    .textarea {
        min-height: 80px;
        resize: vertical;
    }

    input::placeholder,
    .textarea::placeholder {
        color: #a3a3a3;
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

    .settings-row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        flex: 0 0 auto;
        gap: 14px;
    }

    .round-dropdown {
        position: relative;
        z-index: 30;
        width: 100%;
    }

    .round-trigger {
        display: flex;
        box-sizing: border-box;
        width: 100%;
        height: 44px;
        align-items: center;
        justify-content: space-between;
        padding: 7px 14px;
        border: none;
        border-radius: 9px;
        background: #fff;
        color: #1a1440;
        cursor: pointer;
        font-family: inherit;
        font-size: 15px;
        text-align: left;
    }

    .round-trigger:disabled {
        background: #e8e8e8;
        color: #666;
        cursor: not-allowed;
    }

    .round-arrow {
        flex: 0 0 auto;
        margin-left: 6px;
        color: var(--color-surface);
        font-size: 11px;
    }

    .round-trigger:disabled .round-arrow {
        display: none;
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

    .questions-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }

    .questions-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .question-card {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 14px;
        border: 2px solid var(--color-border);
        border-radius: 9px;
        background: var(--color-surface-dark);
    }

    .question-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }

    .question-number {
        color: var(--color-text-primary);
        font-size: 15px;
        font-weight: 800;
    }

    .question-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .choices-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .choice-row {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .choice-row input {
        flex: 1;
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

    .btn-small {
        height: 32px;
        padding: 0 12px;
        font-size: 13px;
        font-weight: 800;
    }

    .btn-danger {
        background: #ff5b6e;
        color: #fff;
    }

    .btn-danger:hover {
        background: #ff4056;
    }

    @media (max-width: 620px) {
        .page-title {
            font-size: 24px;
        }

        .create-form {
            gap: 16px;
            padding: 16px;
        }

        .settings-row {
            grid-template-columns: 1fr;
        }

        .option-row {
            gap: 3px;
        }

        .option-btn {
            padding: 4px 2px;
            font-size: 12px;
        }
    }
</style>