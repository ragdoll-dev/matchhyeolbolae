<!--
  src/routes/+layout.svelte

  전체 앱 공통 레이아웃
  - 모든 페이지가 자동으로 .page-container 안에 배치됨
  - globals.css 에서 정의한 반응형 스타일 적용
-->
<script lang="ts">
    import { removeLegacyRoomPlayerKeys } from '$lib/roomPlayerStorage';
    import { onMount } from 'svelte';
    import '../app.css';

    onMount(() => {
        removeLegacyRoomPlayerKeys();
    });
</script>

<div class="page-container">
    <slot />
</div>