// src/lib/avatarSprite.ts
//
// "16-Char Sprite Collection (Modern Chibis)" 스프라이트시트 좌표 계산 유틸.
// (보정 5차 - 최종: 사용자가 실제 파일 크기를 직접 확인하여 확정한 구조로 재작성)
//
// 확정된 실제 구조:
// - charsetA_3.png = 남자 8명, charsetB_3.png = 여자 8명
// - 시트 전체 크기: 576 x 768px
// - 프레임 크기: 가로 48px x 세로 96px (정사각형이 아니라 세로로 긴 직사각형!)
//   → 가로: 12칸 x 48px = 576px  (캐릭터 4명 x 걷기 3프레임)
//   → 세로: 8칸 x 96px = 768px   (방향 4개 x 캐릭터 블록 2개)
//
// 가로축 (12칸, 48px 단위):
//   [캐릭터1: 정면프레임0,1,2] [캐릭터2: 0,1,2] [캐릭터3: 0,1,2] [캐릭터4: 0,1,2]
//   → col = idx % 4 (블록 내 캐릭터 순번), frameCol = 0 (정지 자세, 사용자 확인됨)
//
// 세로축 (8칸, 96px 단위):
//   행0: 캐릭터1~4 정면   행1: 캐릭터1~4 왼쪽   행2: 캐릭터1~4 오른쪽   행3: 캐릭터1~4 뒤
//   행4: 캐릭터5~8 정면   행5: 캐릭터5~8 왼쪽   행6: 캐릭터5~8 오른쪽   행7: 캐릭터5~8 뒤
//   → blockRow = idx // 4 (0 또는 1), y행 = blockRow * 4 + directionRow
//
// character_index 0~7 매핑:
//   avatar_gender='male'   -> charsetA_3.png
//   avatar_gender='female' -> charsetB_3.png

export const FRAME_WIDTH = 48;
export const FRAME_HEIGHT = 96;
// 하위 호환용 (정사각형 가정 코드가 남아있을 경우를 위해 폭 기준으로 유지)
export const FRAME_SIZE = FRAME_WIDTH;

export const SHEET_WIDTH = 576;
export const SHEET_HEIGHT = 768;

const ROWS_PER_BLOCK = 4; // 블록 하나(캐릭터 4명)가 세로로 차지하는 방향 행 개수

export type WalkDirection = 'down' | 'left' | 'right' | 'up';
export type AvatarGender = 'male' | 'female';

const DIRECTION_ROW: Record<WalkDirection, number> = {
	down: 0,
	left: 1,
	right: 2,
	up: 3
};

function resolveCharacterGrid(characterIndex: number): { col: number; blockRow: number } {
	const idx = ((characterIndex % 8) + 8) % 8;
	return { col: idx % 4, blockRow: Math.floor(idx / 4) };
}

export function sheetUrl(gender: AvatarGender): string {
	return gender === 'male' ? '/avatars/charsetA_3.png' : '/avatars/charsetB_3.png';
}

/**
 * characterIndex(0~7), 성별, 방향에 대한 정지 프레임 좌표를 반환.
 * frameCol=0 (가로 3프레임 중 첫 번째)이 정면 정지 자세로 확인됨.
 */
export function getIdleFramePosition(
	characterIndex: number,
	gender: AvatarGender,
	direction: WalkDirection = 'down'
): { sheet: AvatarGender; x: number; y: number } {
	const { col, blockRow } = resolveCharacterGrid(characterIndex);
	const frameCol = 1;
	const x = (col * 3 + frameCol) * FRAME_WIDTH;
	const y = (blockRow * ROWS_PER_BLOCK + DIRECTION_ROW[direction]) * FRAME_HEIGHT;
	return { sheet: gender, x, y };
}

/**
 * 걷기 애니메이션의 3프레임 x좌표 배열을 반환 (CSS 애니메이션에 사용).
 */
export function getWalkFrameXPositions(characterIndex: number): number[] {
	const { col } = resolveCharacterGrid(characterIndex);
	return [0, 1, 2].map((frameCol) => (col * 3 + frameCol) * FRAME_WIDTH);
}

export function getWalkFrameY(characterIndex: number, direction: WalkDirection = 'down'): number {
	const { blockRow } = resolveCharacterGrid(characterIndex);
	return (blockRow * ROWS_PER_BLOCK + DIRECTION_ROW[direction]) * FRAME_HEIGHT;
}
