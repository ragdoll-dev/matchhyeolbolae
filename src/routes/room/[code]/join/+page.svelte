<!--
  src/routes/room/[code]/join/+page.svelte

  방 입장 (닉네임 + 아바타 입력) 화면 — 전체 페이지 스크롤 제거 버전

  수정 사항
  1. page-container 의 padding(40px)과 join-page 자체 padding이 중복되지 않도록
     join-page 높이를 100dvh - page-container 패딩 으로 고정
  2. FHD 에서는 join-form 내용이 화면 높이를 초과할 수 있으므로,
     join-form 내부에서만 스크롤되게 하여 바깥 페이지 스크롤은 항상 제거
  3. 캐릭터 슬롯 높이를 110px → 100px 로 살짝 줄여 FHD 세로 여유를 확보
  - 닉네임 및 캐릭터 localStorage 지속성 유지
-->
<script lang="ts">
    import { beforeNavigate, goto } from '$app/navigation';
    import { page } from '$app/stores';
    import { FRAME_HEIGHT, FRAME_WIDTH, getIdleFramePosition, sheetUrl } from '$lib/avatarSprite';
    import { toErrorMessage } from '$lib/errorMessage';
    import { saveRoomPlayerId } from '$lib/roomPlayerStorage';
    import { ensureAnonymousSession, supabase } from '$lib/supabaseClient';
    import { onMount } from 'svelte';

    const roomCode = $page.params.code;
    const isHost = $page.url.searchParams.get('host') === '1';
    const NICKNAME_MAX_LENGTH = 12;
    const SAVED_NICKNAME_KEY = 'matchhyeolbolae:last_nickname';
    const SAVED_CHARACTER_KEY = 'matchhyeolbolae:last_character';

    const ALLOWED_CONTROL_KEYS = new Set([
        'Backspace',
        'Delete',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Home',
        'End',
        'Tab',
        'Escape',
        'Enter',
        'Shift',
        'Control',
        'Alt',
        'Meta',
        'CapsLock',
        'Process'
    ]);

    let nickname = $state('');
    let password = $state('');
    let avatarGender = $state<'male' | 'female'>('male');
    let characterIndex = $state(0);
    let nicknameInputRef: HTMLInputElement | null = null;
    let isComposingNickname = false;

    let candidateIndices = $derived([0, 1, 2, 3, 4, 5, 6, 7]);

    let sessionReady = $state(false);
    let sessionError = $state<string | null>(null);
    let isSubmitting = $state(false);
    let errorMessage = $state<string | null>(null);

    let hostRoomId = $state<string | null>(null);
    let hasSubmitted = $state(false);
    let isCancelling = $state(false);

    let isValid = $derived(
        sessionReady && nickname.trim().length > 0 && nickname.trim().length <= NICKNAME_MAX_LENGTH
    );

    function currentSelectionLength(input: HTMLInputElement): number {
        const start = input.selectionStart ?? 0;
        const end = input.selectionEnd ?? 0;
        return end - start;
    }

    function handleNicknameKeydown(event: KeyboardEvent) {
        const input = nicknameInputRef;
        if (!input) return;
        if (event.ctrlKey || event.metaKey) return;
        if (ALLOWED_CONTROL_KEYS.has(event.key)) return;

        if (currentSelectionLength(input) > 0) return;

        if (input.value.length >= NICKNAME_MAX_LENGTH) {
            event.preventDefault();
        }
    }

    function enforceNicknameLength() {
        if (!nicknameInputRef) return;

        const current = nicknameInputRef.value;
        if (current.length > NICKNAME_MAX_LENGTH) {
            const trimmed = current.slice(0, NICKNAME_MAX_LENGTH);
            nicknameInputRef.value = trimmed;
            nickname = trimmed;
            return;
        }

        nickname = current;
    }

    function handleNicknameInput() {
        if (isComposingNickname) {
            if (nicknameInputRef) nickname = nicknameInputRef.value;
            return;
        }

        enforceNicknameLength();
    }

    function handleCompositionStart() {
        isComposingNickname = true;
    }

    function handleCompositionEnd() {
        isComposingNickname = false;
        enforceNicknameLength();
    }

    function selectGender(gender: 'male' | 'female') {
        avatarGender = gender;
        characterIndex = 0;
    }

    function spriteStyle(index: number): string {
        const { sheet, x, y } = getIdleFramePosition(index, avatarGender, 'down');
        return `background-image: url(${sheetUrl(sheet)}); background-position: -${x}px -${y}px;`;
    }

    function characterLabel(index: number): string {
        const displayNumber = index + 1;
        return `${avatarGender === 'male' ? '남성' : '여성'} 캐릭터 ${displayNumber}번 선택`;
    }

    async function resolveRoomId(): Promise<string> {
        const { data, error } = await supabase
            .from('rooms')
            .select('id')
            .eq('code', roomCode)
            .single();

        if (error || !data) throw new Error('방을 찾을 수 없습니다.');
        return data.id;
    }

    async function cancelHostRoomIfNeeded() {
        if (!isHost || hasSubmitted || isCancelling) return;

        isCancelling = true;
        try {
            const roomId = hostRoomId ?? (await resolveRoomId().catch(() => null));
            if (!roomId) return;

            await supabase.rpc('cancel_room', { p_room_id: roomId });
        } catch (err) {
            console.warn('[join] 방 취소 처리 실패:', err);
        } finally {
            isCancelling = false;
        }
    }

    async function handleSubmit(event: SubmitEvent) {
        event.preventDefault();
        if (!isValid || isSubmitting) return;

        const trimmedNickname = nickname.trim();
        isSubmitting = true;
        errorMessage = null;

        try {
            await ensureAnonymousSession();

            let playerId: string;

            if (isHost) {
                const roomId = await resolveRoomId();
                hostRoomId = roomId;

                const { data, error } = await supabase.rpc('join_room_as_host', {
                    p_room_id: roomId,
                    p_nickname: trimmedNickname,
                    p_avatar_gender: avatarGender,
                    p_character_index: characterIndex
                });

                if (error) throw error;
                const row = Array.isArray(data) ? data[0] : data;
                if (!row) throw new Error('입장 응답이 비어 있습니다.');
                playerId = row.player_id;
            } else {
                const { data, error } = await supabase.rpc('join_room', {
                    p_code: roomCode,
                    p_password: password.trim() === '' ? null : password.trim(),
                    p_invite_token: null,
                    p_nickname: trimmedNickname,
                    p_avatar_gender: avatarGender,
                    p_character_index: characterIndex
                });

                if (error) throw error;
                const row = Array.isArray(data) ? data[0] : data;
                if (!row) throw new Error('입장 응답이 비어 있습니다.');
                playerId = row.player_id;
            }

            hasSubmitted = true;
            localStorage.setItem(SAVED_NICKNAME_KEY, trimmedNickname);
            localStorage.setItem(
                SAVED_CHARACTER_KEY,
                JSON.stringify({
                    gender: avatarGender,
                    index: characterIndex
                })
            );
            saveRoomPlayerId(roomCode, playerId);
            goto(`/room/${roomCode}`);
        } catch (err) {
            errorMessage = toErrorMessage(err);
        } finally {
            isSubmitting = false;
        }
    }

    async function handleCancel() {
        if (isHost) {
            await cancelHostRoomIfNeeded();
        }
        goto('/');
    }

    onMount(async () => {
        const savedNickname = localStorage.getItem(SAVED_NICKNAME_KEY);
        if (savedNickname) {
            nickname = savedNickname.slice(0, NICKNAME_MAX_LENGTH);
        }

        const savedCharacterJson = localStorage.getItem(SAVED_CHARACTER_KEY);
        if (savedCharacterJson) {
            try {
                const saved = JSON.parse(savedCharacterJson) as {
                    gender: 'male' | 'female';
                    index: number;
                };
                if (saved.gender === 'male' || saved.gender === 'female') {
                    avatarGender = saved.gender;
                }
                if (
                    typeof saved.index === 'number' &&
                    saved.index >= 0 &&
                    saved.index <= 7
                ) {
                    characterIndex = saved.index;
                }
            } catch {
                // 무시
            }
        }

        try {
            await ensureAnonymousSession();
            sessionReady = true;
        } catch (err) {
            sessionError = toErrorMessage(err);
        }

        if (isHost) {
            try {
                hostRoomId = await resolveRoomId();
            } catch {
                hostRoomId = null;
            }
        }
    });

    beforeNavigate(() => {
        if (isHost && !hasSubmitted) {
            void cancelHostRoomIfNeeded();
        }
    });
</script>

<div class="join-page">
    <div class="form-shell">
        <h1 class="page-title text-center">{isHost ? '방 만들기 완료' : '방 입장'}</h1>
        <p class="room-code-line text-center">
            방 번호 <span class="room-code-value">{roomCode}</span>
        </p>

        {#if sessionError}
            <p class="error-text session-error text-center">로그인 초기화에 실패했습니다: {sessionError}</p>
        {/if}

        <form class="join-form" onsubmit={handleSubmit}>
            <section class="field-group">
                <label class="field-label" for="nickname">
                    닉네임 <span class="field-label-hint">(최대 {NICKNAME_MAX_LENGTH} 자)</span>
                </label>
                <input
                    id="nickname"
                    class="input"
                    type="text"
                    placeholder="게임에서 사용할 닉네임"
                    value={nickname}
                    bind:this={nicknameInputRef}
                    maxlength={NICKNAME_MAX_LENGTH}
                    onkeydown={handleNicknameKeydown}
                    oninput={handleNicknameInput}
                    oncompositionstart={handleCompositionStart}
                    oncompositionend={handleCompositionEnd}
                    required
                />
            </section>

            {#if !isHost}
                <section class="field-group">
                    <label class="field-label" for="password">비밀번호 (비공개방인 경우)</label>
                    <input
                        id="password"
                        class="input"
                        type="password"
                        placeholder="비공개방이 아니면 비워두세요"
                        bind:value={password}
                        maxlength="20"
                    />
                </section>
            {/if}

            <section class="field-group">
                <span class="field-label">성별</span>
                <div class="gender-row">
                    <button
                        type="button"
                        class="gender-btn {avatarGender === 'male' ? 'selected' : ''}"
                        onclick={() => selectGender('male')}
                    >
                        남성
                    </button>
                    <button
                        type="button"
                        class="gender-btn {avatarGender === 'female' ? 'selected' : ''}"
                        onclick={() => selectGender('female')}
                    >
                        여성
                    </button>
                </div>
            </section>

            <section class="field-group character-field-group">
                <span class="field-label">캐릭터 선택</span>
                <div class="character-grid">
                    {#each candidateIndices as idx (idx)}
                        <button
                            type="button"
                            class="character-slot {characterIndex === idx ? 'selected' : ''}"
                            onclick={() => (characterIndex = idx)}
                            aria-label={characterLabel(idx)}
                            aria-pressed={characterIndex === idx}
                        >
                            <span
                                class="character-sprite"
                                style={`width: ${FRAME_WIDTH}px; height: ${FRAME_HEIGHT}px; ${spriteStyle(idx)}`}
                            ></span>
                        </button>
                    {/each}
                </div>
            </section>

            {#if errorMessage}
                <p class="error-text">입장에 실패했습니다: {errorMessage}</p>
            {/if}

            <div class="button-row">
                <button type="button" class="btn cancel-btn" onclick={handleCancel} disabled={isSubmitting}>
                    취소
                </button>
                <button type="submit" class="btn btn-primary submit-btn" disabled={!isValid || isSubmitting}>
                    {isSubmitting ? '입장 중...' : '대기실 입장'}
                </button>
            </div>
        </form>
    </div>
</div>

<style>
    /*
      page-container 가 이미 상하 padding: var(--page-padding-y)(40px)를 주고 있으므로,
      join-page 는 추가 padding 없이 높이만 100dvh - page-container 패딩 으로 고정한다.
      이렇게 하면 FHD 에서도 전체 페이지 스크롤이 생기지 않는다.
    */
    .join-page {
        display: flex;
        align-items: center;
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
        max-width: 480px;
        height: 100%;
        min-height: 0;
    }

    .page-title {
        flex: 0 0 auto;
        margin-bottom: 6px;
    }

    .room-code-line {
        flex: 0 0 auto;
        margin-bottom: 14px;
        color: var(--color-text-secondary);
        font-weight: 700;
    }

    .room-code-value {
        padding: 3px 10px;
        border-radius: 6px;
        background: var(--color-surface-dark);
        color: var(--color-accent);
        font-weight: 900;
    }

    .session-error {
        flex: 0 0 auto;
        margin-bottom: 12px;
    }

    /*
      폼 내부가 화면보다 길어질 경우에만 이 영역 안에서 스크롤되도록 한다.
      바깥 join-page/전체 페이지는 절대 스크롤되지 않는다.
    */
    .join-form {
        display: flex;
        flex-direction: column;
        gap: 16px;
        min-height: 0;
        padding: 24px;
        overflow-y: auto;
        border: 2px solid var(--color-border);
        border-radius: 14px;
        background: var(--color-surface);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    }

    .field-group {
        display: flex;
        flex-direction: column;
        gap: 7px;
        flex: 0 0 auto;
    }

    .character-field-group {
        min-height: 0;
    }

    .field-label {
        color: var(--color-text-secondary);
        font-size: 14px;
        font-weight: 800;
    }

    .field-label-hint {
        color: var(--color-text-muted);
        font-size: 12px;
        font-weight: 600;
    }

    .gender-row {
        display: flex;
        gap: 11px;
    }

    .gender-btn {
        flex: 1;
        padding: 10px;
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
      캐릭터 그리드: 슬롯 높이를 110px → 100px 로 축소해 FHD 세로 공간을 확보.
      필요 시 이 영역 자체가 줄어들 수 있도록 min-height:0 을 부모에 부여했다.
    */
    .character-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        grid-auto-rows: 100px;
        gap: 9px;
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
        bottom: 4px;
        flex-shrink: 0;
        background-repeat: no-repeat;
        image-rendering: pixelated;
        transform: scale(1.5);
        transform-origin: bottom center;
    }

    .button-row {
        display: flex;
        flex: 0 0 auto;
        gap: 13px;
        margin-top: 2px;
    }

    .cancel-btn {
        flex: 1;
    }

    .submit-btn {
        flex: 2;
    }

    /*
      낮은 FHD 창/작은 노트북/브라우저 비최대화 상태 안전장치.
      세로 공간이 더 부족할 때 캐릭터 슬롯과 폼 패딩을 한 번 더 줄인다.
    */
    @media (max-height: 800px) {
        .join-form {
            gap: 12px;
            padding: 18px;
        }

        .character-grid {
            grid-auto-rows: 84px;
        }

        .character-sprite {
            transform: scale(1.2);
        }
    }

    @media (max-width: 640px) {
        .join-page {
            height: auto;
            min-height: calc(100dvh - (var(--page-padding-y) * 2));
            overflow: visible;
        }

        .form-shell {
            height: auto;
        }

        .join-form {
            padding: 24px;
            gap: 18px;
            overflow-y: visible;
        }

        .character-grid {
            grid-auto-rows: 90px;
            gap: 8px;
        }

        .character-sprite {
            transform: scale(1.4);
        }

        .button-row {
            gap: 10px;
        }
    }
</style>