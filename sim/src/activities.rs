//! Activity queues (SPEC §2.1/§2.2): Rust port of the exercised
//! surface of `src/sim/activities/index.ts` — queue ops plus the
//! digest-visible numeric encode/decode. All 14 kinds encode/decode
//! with the TS stable kind codes except `pack`, whose payload needs
//! the unit-definition code table (lands with definitions in E3c+);
//! encoding/decoding a pack row returns an error until then. Decode
//! validations here cover the movement kinds strictly (move/patrol
//! cursor checks) and the scalar kinds' payload lengths, matching TS.

pub const KIND_MOVE: f64 = 1.0;
pub const KIND_WAIT: f64 = 2.0;
pub const KIND_GATHER: f64 = 3.0;
pub const KIND_DELIVER: f64 = 4.0;
pub const KIND_ATTACK: f64 = 5.0;
pub const KIND_ATTACK_MOVE: f64 = 6.0;
pub const KIND_EAT: f64 = 7.0;
pub const KIND_SLEEP: f64 = 8.0;
pub const KIND_LEISURE: f64 = 9.0;
pub const KIND_PATROL: f64 = 10.0;
pub const KIND_GUARD: f64 = 11.0;
pub const KIND_GARRISON: f64 = 12.0;
pub const KIND_PACK: f64 = 13.0;
pub const KIND_CONVERT: f64 = 14.0;

#[derive(Clone, PartialEq, Debug)]
pub enum Activity {
    Move { waypoints: Vec<f64>, cursor: usize },
    Wait { ticks: f64 },
    Gather { ticks_per_unit: f64, elapsed_ticks: f64 },
    Deliver { dropoff_eid: f64 },
    Attack { target_eid: f64 },
    AttackMove { waypoints: Vec<f64>, cursor: usize },
    Eat { dropoff_eid: f64 },
    Sleep { wake_tick: f64, is_nap: bool },
    Leisure { venue_code: f64, target_eid: f64 },
    Patrol { waypoints: Vec<f64>, cursor: usize, direction: i32 },
    Guard { target_eid: f64 },
    Garrison { target_building_id: f64 },
    Pack { remaining_ticks: f64, target_unit_id: String },
    Convert { target_eid: f64 },
}

impl Activity {
    pub fn kind_name(&self) -> &'static str {
        match self {
            Activity::Move { .. } => "move",
            Activity::Wait { .. } => "wait",
            Activity::Gather { .. } => "gather",
            Activity::Deliver { .. } => "deliver",
            Activity::Attack { .. } => "attack",
            Activity::AttackMove { .. } => "attackMove",
            Activity::Eat { .. } => "eat",
            Activity::Sleep { .. } => "sleep",
            Activity::Leisure { .. } => "leisure",
            Activity::Patrol { .. } => "patrol",
            Activity::Guard { .. } => "guard",
            Activity::Garrison { .. } => "garrison",
            Activity::Pack { .. } => "pack",
            Activity::Convert { .. } => "convert",
        }
    }
    pub fn is_movement_head(&self) -> bool {
        matches!(self, Activity::Move { .. } | Activity::AttackMove { .. } | Activity::Patrol { .. })
    }
    pub fn waypoints_mut(&mut self) -> Option<(&mut Vec<f64>, &mut usize)> {
        match self {
            Activity::Move { waypoints, cursor }
            | Activity::AttackMove { waypoints, cursor }
            | Activity::Patrol { waypoints, cursor, .. } => Some((waypoints, cursor)),
            _ => None,
        }
    }
    pub fn waypoints(&self) -> Option<&[f64]> {
        match self {
            Activity::Move { waypoints, .. }
            | Activity::AttackMove { waypoints, .. }
            | Activity::Patrol { waypoints, .. } => Some(waypoints),
            _ => None,
        }
    }
}

pub type ActivityQueue = Vec<Activity>;

pub fn peek(queue: &[Activity]) -> Option<&Activity> {
    queue.first()
}

pub fn dequeue_current(queue: &mut ActivityQueue) {
    if !queue.is_empty() {
        queue.remove(0);
    }
}

pub fn cancel_activities(queue: &mut ActivityQueue) {
    queue.clear();
}

pub fn get_last_queued_destination(queue: &[Activity], default_x: f64, default_y: f64) -> (f64, f64) {
    for act in queue.iter().rev() {
        if let Some(wp) = act.waypoints() {
            if wp.len() >= 2 {
                return (wp[wp.len() - 2], wp[wp.len() - 1]);
            }
        }
    }
    (default_x, default_y)
}

pub fn move_activity(waypoints: &[f64]) -> Result<Activity, String> {
    if waypoints.len() < 2 || waypoints.len() % 2 != 0 {
        return Err(format!(
            "move activity needs an even number of waypoint coordinates ≥ 2, got {}",
            waypoints.len()
        ));
    }
    Ok(Activity::Move { waypoints: waypoints.to_vec(), cursor: 0 })
}

pub fn encode_activities(queue: &[Activity]) -> Result<Vec<f64>, String> {
    let mut row = vec![queue.len() as f64];
    for activity in queue {
        match activity {
            Activity::Move { waypoints, cursor } => {
                row.push(KIND_MOVE);
                row.push(waypoints.len() as f64 + 1.0);
                row.push(*cursor as f64);
                row.extend_from_slice(waypoints);
            }
            Activity::AttackMove { waypoints, cursor } => {
                row.push(KIND_ATTACK_MOVE);
                row.push(waypoints.len() as f64 + 1.0);
                row.push(*cursor as f64);
                row.extend_from_slice(waypoints);
            }
            Activity::Wait { ticks } => row.extend_from_slice(&[KIND_WAIT, 1.0, *ticks]),
            Activity::Gather { ticks_per_unit, elapsed_ticks } => {
                row.extend_from_slice(&[KIND_GATHER, 2.0, *ticks_per_unit, *elapsed_ticks])
            }
            Activity::Deliver { dropoff_eid } => row.extend_from_slice(&[KIND_DELIVER, 1.0, *dropoff_eid]),
            Activity::Attack { target_eid } => row.extend_from_slice(&[KIND_ATTACK, 1.0, *target_eid]),
            Activity::Eat { dropoff_eid } => row.extend_from_slice(&[KIND_EAT, 1.0, *dropoff_eid]),
            Activity::Sleep { wake_tick, is_nap } => {
                row.extend_from_slice(&[KIND_SLEEP, 2.0, *wake_tick, if *is_nap { 1.0 } else { 0.0 }])
            }
            Activity::Leisure { venue_code, target_eid } => {
                row.extend_from_slice(&[KIND_LEISURE, 2.0, *venue_code, *target_eid])
            }
            Activity::Patrol { waypoints, cursor, direction } => {
                row.push(KIND_PATROL);
                row.push(waypoints.len() as f64 + 2.0);
                row.push(*cursor as f64);
                row.push(if *direction == -1 { 0.0 } else { 1.0 });
                row.extend_from_slice(waypoints);
            }
            Activity::Guard { target_eid } => row.extend_from_slice(&[KIND_GUARD, 1.0, *target_eid]),
            Activity::Garrison { target_building_id } => {
                row.extend_from_slice(&[KIND_GARRISON, 1.0, *target_building_id])
            }
            Activity::Pack { remaining_ticks, target_unit_id } => {
                // Pack payloads carry the target's stable unit code.
                // Morph targets in shipped content are canonical ids
                // (trebuchet pair), whose codes are registry-order
                // stable; a non-canonical target errors loudly.
                let code = crate::defs::CANONICAL_UNIT_IDS
                    .iter()
                    .position(|id| *id == target_unit_id.as_str())
                    .map(|i| i as f64 + 1.0)
                    .ok_or_else(|| format!("pack target {target_unit_id:?} is not a canonical unit id"))?;
                row.extend_from_slice(&[KIND_PACK, 2.0, *remaining_ticks, code]);
            }
            Activity::Convert { target_eid } => row.extend_from_slice(&[KIND_CONVERT, 1.0, *target_eid]),
        }
    }
    Ok(row)
}

fn is_int(v: f64) -> bool {
    v.is_finite() && v.trunc() == v
}

pub fn decode_activities(row: &[f64]) -> Result<ActivityQueue, String> {
    let raw_count = row.first().copied();
    let Some(count) = raw_count else {
        return Err("activity row has malformed count: undefined".into());
    };
    if !is_int(count) || count < 0.0 {
        return Err(format!("activity row has malformed count: {count}"));
    }
    let count = count as usize;
    let mut queue = Vec::with_capacity(count);
    let mut at = 1usize;
    for i in 0..count {
        let kind = row.get(at).copied();
        let payload_len = row.get(at + 1).copied();
        let (Some(kind), Some(payload_len)) = (kind, payload_len) else {
            return Err(format!("activity row entry {i} is malformed"));
        };
        if !is_int(payload_len) || payload_len < 0.0 {
            return Err(format!("activity row entry {i} is malformed"));
        }
        let payload_len = payload_len as usize;
        let payload = &row[at + 2..at + 2 + payload_len.min(row.len().saturating_sub(at + 2))];
        if payload.len() < payload_len {
            return Err(format!("activity row entry {i} truncated"));
        }
        let one = |name: &str| -> Result<f64, String> {
            if payload_len != 1 {
                return Err(format!("{name} activity {i} must carry exactly one value"));
            }
            Ok(payload[0])
        };
        let two = |name: &str| -> Result<(f64, f64), String> {
            if payload_len != 2 {
                return Err(format!("{name} activity {i} must carry exactly two values"));
            }
            Ok((payload[0], payload[1]))
        };
        let activity = if kind == KIND_MOVE || kind == KIND_ATTACK_MOVE {
            let name = if kind == KIND_MOVE { "move" } else { "attackMove" };
            if payload_len < 3 || (payload_len - 1) % 2 != 0 {
                return Err(format!("{name} activity {i} has malformed waypoint payload"));
            }
            let cursor = payload[0];
            if !is_int(cursor) || cursor < 0.0 || cursor as i64 % 2 != 0 || cursor as usize > payload_len - 3 {
                return Err(format!("{name} activity {i} has out-of-range cursor"));
            }
            let waypoints = payload[1..].to_vec();
            if kind == KIND_MOVE {
                Activity::Move { waypoints, cursor: cursor as usize }
            } else {
                Activity::AttackMove { waypoints, cursor: cursor as usize }
            }
        } else if kind == KIND_WAIT {
            Activity::Wait { ticks: one("wait")? }
        } else if kind == KIND_GATHER {
            let (ticks_per_unit, elapsed_ticks) = two("gather")?;
            if !is_int(ticks_per_unit) || ticks_per_unit <= 0.0 {
                return Err(format!("gather activity {i} has malformed ticks per unit"));
            }
            if !is_int(elapsed_ticks) || elapsed_ticks < 0.0 || elapsed_ticks >= ticks_per_unit {
                return Err(format!("gather activity {i} has out-of-range elapsed ticks"));
            }
            Activity::Gather { ticks_per_unit, elapsed_ticks }
        } else if kind == KIND_DELIVER {
            let v = one("deliver")?;
            if !is_int(v) || v < 1.0 {
                return Err(format!("deliver activity {i} has malformed drop-off entity id"));
            }
            Activity::Deliver { dropoff_eid: v }
        } else if kind == KIND_ATTACK {
            Activity::Attack { target_eid: one("attack")? }
        } else if kind == KIND_EAT {
            Activity::Eat { dropoff_eid: one("eat")? }
        } else if kind == KIND_SLEEP {
            let (wake_tick, nap) = two("sleep")?;
            Activity::Sleep { wake_tick, is_nap: nap != 0.0 }
        } else if kind == KIND_LEISURE {
            let (venue_code, target_eid) = two("leisure")?;
            Activity::Leisure { venue_code, target_eid }
        } else if kind == KIND_PATROL {
            if payload_len < 4 || (payload_len - 2) % 2 != 0 {
                return Err(format!("patrol activity {i} has malformed waypoint payload"));
            }
            Activity::Patrol {
                waypoints: payload[2..].to_vec(),
                cursor: payload[0] as usize,
                direction: if payload[1] == 0.0 { -1 } else { 1 },
            }
        } else if kind == KIND_GUARD {
            Activity::Guard { target_eid: one("guard")? }
        } else if kind == KIND_GARRISON {
            Activity::Garrison { target_building_id: one("garrison")? }
        } else if kind == KIND_PACK {
            let (remaining_ticks, code) = two("pack")?;
            let target_unit_id = crate::defs::CANONICAL_UNIT_IDS
                .get((code as i64 - 1) as usize)
                .ok_or_else(|| format!("pack activity {i} has unknown unit code {code}"))?
                .to_string();
            Activity::Pack { remaining_ticks, target_unit_id }
        } else if kind == KIND_CONVERT {
            Activity::Convert { target_eid: one("convert")? }
        } else {
            return Err(format!("unknown activity kind code: {kind}"));
        };
        queue.push(activity);
        at += 2 + payload_len;
    }
    Ok(queue)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_round_trip() {
        let queue = vec![
            Activity::Move { waypoints: vec![1.5, 2.5, 3.5, 4.5], cursor: 2 },
            Activity::Wait { ticks: 7.0 },
            Activity::AttackMove { waypoints: vec![0.5, 0.5], cursor: 0 },
            Activity::Sleep { wake_tick: 100.0, is_nap: true },
            Activity::Patrol { waypoints: vec![1.0, 1.0, 2.0, 2.0], cursor: 2, direction: -1 },
            Activity::Deliver { dropoff_eid: 42.0 },
        ];
        let row = encode_activities(&queue).unwrap();
        assert_eq!(row[0], 6.0);
        assert_eq!(decode_activities(&row).unwrap(), queue);
        assert_eq!(decode_activities(&[0.0]).unwrap(), Vec::<Activity>::new());
        assert!(decode_activities(&[1.0, KIND_MOVE, 2.0, 0.0, 1.0]).is_err(), "short waypoint payload");
        assert!(decode_activities(&[1.0, 99.0, 0.0]).is_err(), "unknown kind");
    }

    #[test]
    fn last_queued_destination_falls_back() {
        let queue = vec![
            Activity::Wait { ticks: 1.0 },
            Activity::Move { waypoints: vec![3.0, 4.0, 9.0, 8.0], cursor: 0 },
        ];
        assert_eq!(get_last_queued_destination(&queue, 7.0, 7.0), (9.0, 8.0));
        assert_eq!(get_last_queued_destination(&[], 7.0, 7.0), (7.0, 7.0));
    }
}
