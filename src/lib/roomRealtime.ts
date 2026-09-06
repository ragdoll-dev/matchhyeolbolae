// src/lib/roomRealtime.ts
//
// 방(room) 단위 Supabase Realtime 구독 유틸리티.
//
// players DELETE 이벤트는 Postgres Changes에서 room_id 필터가 안정적으로 적용되지 않을 수 있다.
// 따라서 players 이벤트는 필터 없이 수신하고, 각 화면에서는 이벤트를 신호로 사용해
// 해당 room_id의 최신 players 목록을 다시 조회한다.
//
// chat_messages / reveal 판정은 postgres_changes(DB 변경 감지) 대신 Broadcast를 우선 경로로 쓴다.
// Broadcast는 WAL 감지를 거치지 않고 클라이언트 간 직접 전달되어 지연이 훨씬 짧다(수십~수백ms).
// postgres_changes 구독은 네트워크 문제로 Broadcast를 놓쳤을 때를 위한 안전망으로 계속 유지하며,
// 두 경로 모두 같은 id를 기준으로 중복 처리를 막아야 한다(페이지 쪽에서 처리).

import { supabase } from '$lib/supabaseClient';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface RoomRow {
    id: string;
    code: string;
    title: string;
    host_id: string | null;
    status: 'waiting' | 'playing' | 'finished';
    max_players: number;
    time_limit_seconds: 15 | 30 | 60;
    total_rounds: number;
    current_round: number;
    answer_reveal_seconds: number;
    minigame_id: string | null;
}

export interface GameSessionRow {
    id: string;
    room_id: string;
    question_id: string | null;
    question_started_at: string | null;
    submission_deadline_at: string | null;
    answer_revealed_at: string | null;
    next_round_at: string | null;
    phase: 'question' | 'reveal' | 'finished';
}

export interface ChatMessageRow {
    id: string;
    room_id: string;
    player_id: string;
    question_id: string | null;
    message: string;
    is_correct_answer: boolean;
    created_at: string;
}

export interface PlayerRow {
    id: string;
    room_id: string;
    nickname: string;
    is_host: boolean;
    score: number;
    connection_status: string;
    avatar_gender: string;
    character_index: number;
    equipped_items: Record<string, unknown>;
    // 대기실 레디 상태. 방장은 항상 의미 없는 값(false)이며 UI에서 판단하지 않는다.
    // 방장이 아닌 참가자만 이 값을 토글할 수 있다(toggle_player_ready RPC).
    is_ready: boolean;
}

export interface RevealBroadcastPayload {
    room_id: string;
    question_id: string | null;
    correct_player_id: string | null;
}

export interface RoomRealtimeCallbacks {
    onRoomChange?: (row: RoomRow) => void;
    onGameSessionChange?: (row: GameSessionRow) => void;
    onChatMessage?: (row: ChatMessageRow) => void;
    onRevealBroadcast?: (payload: RevealBroadcastPayload) => void;
    onPlayerChange?: (
        row: PlayerRow | null,
        eventType: 'INSERT' | 'UPDATE' | 'DELETE',
        oldRow: PlayerRow | null
    ) => void;
}

/**
 * 특정 방에 대한 Realtime 채널을 연다.
 *
 * rooms, game_sessions는 room_id 필터를 적용한 postgres_changes 로 구독한다.
 * chat_messages는 Broadcast('chat_message')를 우선 경로로 쓰고, postgres_changes 는
 * 안전망으로 함께 구독한다. reveal 판정도 Broadcast('reveal_answer')로 즉시 전파한다.
 * players 테이블 변경(INSERT/UPDATE/DELETE)은 is_ready 토글을 포함해 모두 이 경로로 감지되며,
 * DELETE는 Postgres Changes의 filter 제약 때문에 필터 없이 감지한다.
 * 페이지 콜백은 수신한 players 이벤트를 최신 목록 재조회 신호로 취급해야 한다.
 */
export function subscribeToRoom(roomId: string, callbacks: RoomRealtimeCallbacks): RealtimeChannel {
    const channel = supabase
        .channel(`room:${roomId}`, {
            config: {
                broadcast: { self: false }
            }
        })
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` },
            (payload) => {
                callbacks.onRoomChange?.(payload.new as RoomRow);
            }
        )
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'game_sessions', filter: `room_id=eq.${roomId}` },
            (payload) => {
                callbacks.onGameSessionChange?.(payload.new as GameSessionRow);
            }
        )
        .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `room_id=eq.${roomId}` },
            (payload) => {
                callbacks.onChatMessage?.(payload.new as ChatMessageRow);
            }
        )
        .on('broadcast', { event: 'chat_message' }, (payload) => {
            callbacks.onChatMessage?.(payload.payload as ChatMessageRow);
        })
        .on('broadcast', { event: 'reveal_answer' }, (payload) => {
            callbacks.onRevealBroadcast?.(payload.payload as RevealBroadcastPayload);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, (payload) => {
            const eventType = payload.eventType as 'INSERT' | 'UPDATE' | 'DELETE';
            const row = (payload.new || null) as PlayerRow | null;
            const oldRow = (payload.old || null) as PlayerRow | null;

            if (eventType !== 'DELETE' && row?.room_id !== roomId) return;

            callbacks.onPlayerChange?.(row, eventType, oldRow);
        })
        .subscribe((status) => {
            console.log(`[roomRealtime] room:${roomId} 채널 상태:`, status);
        });

    return channel;
}

/**
 * 채팅 메시지를 채널 구독자 전체에게 즉시 브로드캐스트한다.
 * DB INSERT(send_message RPC) 성공 직후, 호출한 클라이언트가 이 함수로
 * 같은 payload 를 곧바로 전파해 postgres_changes 의 WAL 감지 지연을 건너뛴다.
 */
export function broadcastChatMessage(channel: RealtimeChannel, row: ChatMessageRow): void {
    void channel.send({
        type: 'broadcast',
        event: 'chat_message',
        payload: row
    });
}

/**
 * 정답 판정 결과를 채널 구독자 전체에게 즉시 브로드캐스트한다.
 * reveal_answer RPC 성공 직후, 호출한 클라이언트(호스트)가 곧바로 전파해
 * game_sessions UPDATE 의 postgres_changes 감지 지연을 건너뛴다.
 */
export function broadcastRevealAnswer(
    channel: RealtimeChannel,
    payload: RevealBroadcastPayload
): void {
    void channel.send({
        type: 'broadcast',
        event: 'reveal_answer',
        payload
    });
}

export function unsubscribeFromRoom(channel: RealtimeChannel): void {
    supabase.removeChannel(channel);
}
