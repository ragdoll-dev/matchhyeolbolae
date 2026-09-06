const ROOM_PLAYER_STORAGE_KEY = 'matchhyeolbolae:room_players';
const MAX_SAVED_ROOMS = 2;

type SavedRoomPlayers = Record<
	string,
	{
		playerId: string;
		updatedAt: number;
	}
>;

function readSavedRoomPlayers(): SavedRoomPlayers {
	if (typeof localStorage === 'undefined') {
		return {};
	}

	try {
		const raw = localStorage.getItem(ROOM_PLAYER_STORAGE_KEY);

		if (!raw) {
			return {};
		}

		const parsed = JSON.parse(raw) as unknown;

		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}

		const entries = Object.entries(parsed).filter(([roomCode, value]) => {
			if (!roomCode || !value || typeof value !== 'object') {
				return false;
			}

			const item = value as {
				playerId?: unknown;
				updatedAt?: unknown;
			};

			return (
				typeof item.playerId === 'string' &&
				item.playerId.length > 0 &&
				typeof item.updatedAt === 'number'
			);
		});

		return Object.fromEntries(entries) as SavedRoomPlayers;
	} catch {
		/*
          이전 개발 과정에서 남은 잘못된 JSON,
          수동으로 변경된 localStorage 값 등은 무시한다.
        */
		return {};
	}
}

function writeSavedRoomPlayers(items: SavedRoomPlayers): void {
	if (typeof localStorage === 'undefined') {
		return;
	}

	localStorage.setItem(ROOM_PLAYER_STORAGE_KEY, JSON.stringify(items));
}

function trimSavedRooms(items: SavedRoomPlayers): SavedRoomPlayers {
	const sortedEntries = Object.entries(items).sort(([, a], [, b]) => b.updatedAt - a.updatedAt);

	return Object.fromEntries(sortedEntries.slice(0, MAX_SAVED_ROOMS));
}

/*
  특정 방의 player ID를 저장하거나 갱신한다.

  같은 roomCode에 대해 다시 호출하면 기존 항목을 덮어쓴다.
  전체 저장 방 개수는 최근 5개로 제한한다.
*/
export function saveRoomPlayerId(roomCode: string, playerId: string): void {
	const items = readSavedRoomPlayers();

	items[roomCode] = {
		playerId,
		updatedAt: Date.now()
	};

	writeSavedRoomPlayers(trimSavedRooms(items));
}

/*
  특정 방의 player ID를 읽는다.
*/
export function getRoomPlayerId(roomCode: string): string | null {
	const items = readSavedRoomPlayers();
	const item = items[roomCode];

	if (!item) {
		return null;
	}

	return item.playerId;
}

/*
  방에서 완전히 나가거나 방장이 방을 취소했을 때,
  해당 방의 저장된 player ID만 제거한다.
*/
export function removeRoomPlayerId(roomCode: string): void {
	const items = readSavedRoomPlayers();

	if (!(roomCode in items)) {
		return;
	}

	delete items[roomCode];
	writeSavedRoomPlayers(items);
}

export function removeLegacyRoomPlayerKeys(): void {
	if (typeof localStorage === 'undefined') {
		return;
	}

	const keysToRemove: string[] = [];

	for (let index = 0; index < localStorage.length; index += 1) {
		const key = localStorage.key(index);

		if (key?.startsWith('player_id:')) {
			keysToRemove.push(key);
		}
	}

	for (const key of keysToRemove) {
		localStorage.removeItem(key);
	}
}
