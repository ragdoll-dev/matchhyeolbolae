// src/lib/roomListRealtime.ts
//
// 홈(메인) 화면의 "전체 방 목록"을 실시간으로 갱신하기 위한 구독 유틸리티.
// roomRealtime.ts(특정 방 하나)와는 별개로, rooms/players 테이블 전체의
// INSERT/UPDATE/DELETE를 구독해서 "무언가 바뀌었다"는 신호만 받고,
// 실제 목록은 room_list 뷰를 다시 조회(refetch)하는 방식으로 갱신한다.
//
// room_list가 여러 테이블을 조인한 뷰라 postgres_changes로 뷰 자체를 구독할 수는 없으므로,
// 원본 테이블(rooms, players) 변경을 감지해 재조회를 트리거하는 구조를 쓴다.

import { supabase } from '$lib/supabaseClient';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface RoomListRow {
	room_id: string;
	code: string;
	title: string;
	status: 'waiting' | 'playing' | 'finished';
	max_players: number;
	time_limit_seconds: number;
	total_rounds: number;
	current_round: number;
	has_password: boolean;
	minigame_title: string | null;
	minigame_slug: string | null;
	current_players: number;
	created_at: string;
}

export async function fetchRoomList(): Promise<RoomListRow[]> {
	const { data, error } = await supabase
		.from('room_list')
		.select('*')
		.order('created_at', { ascending: false });

	if (error) {
		throw new Error(`방 목록 조회 실패: ${error.message}`);
	}
	return (data ?? []) as RoomListRow[];
}

/**
 * rooms 또는 players 테이블에 변화가 생길 때마다 onChange 콜백을 호출한다.
 * 콜백 안에서 fetchRoomList()를 다시 호출해 목록을 갱신하는 패턴으로 사용.
 */
export function subscribeToRoomListChanges(onChange: () => void): RealtimeChannel {
	const channel = supabase
		.channel('room-list-watcher')
		.on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, () => {
			onChange();
		})
		.on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, () => {
			onChange();
		})
		.subscribe((status) => {
			console.log('[roomListRealtime] room-list-watcher 채널 상태:', status);
		});

	return channel;
}

export function unsubscribeFromRoomList(channel: RealtimeChannel): void {
	supabase.removeChannel(channel);
}
