//! Economy components + per-player stockpile ledgers (SPEC §2.6):
//! Rust port of `src/sim/components/economy.ts` and
//! `src/sim/core/stockpile.ts`. Row layouts are digest contract:
//! - AssignedNode (2): [nodeEid, claimedSlotIndex] (−1 = overflow)
//! - CarryCapacity (1): [maxUnitsOfOneResource]
//! - Inventory (2): [resourceCode, carriedAmount]
//! - ResourceNode (3): [resourceCode, remainingUnits, workSlotCount]
//! - Stockpile (8): [owner, food, wood, gold, stone, iron, coal, clay]
//! - CommodityStockpile (7): [owner, planks, bricks, tools, weapons,
//!   armor, meals]
//! - DropOff (2): [owner, acceptedResourceMask]
use crate::core::{Eid, World};
use crate::defs::{COMMODITY_SLUGS, RESOURCE_SLUGS};

pub const RESOURCE_COUNT: usize = 7;
pub const COMMODITY_COUNT: usize = 6;
pub const PLAYER_ONE: f64 = 0.0;
pub const WORK_SLOTS_PER_NODE: f64 = 8.0;
pub const DEFAULT_CARRY_CAPACITY: f64 = 10.0;
pub const ALL_RESOURCES_MASK: f64 = ((1 << RESOURCE_COUNT) - 1) as f64;

pub fn require_resource_code(code: i64) -> Result<i64, String> {
    if code < 0 || code >= RESOURCE_COUNT as i64 {
        return Err(format!("unknown resource code: {code}"));
    }
    Ok(code)
}
pub fn require_commodity_code(code: i64) -> Result<i64, String> {
    if code < 0 || code >= COMMODITY_COUNT as i64 {
        return Err(format!("unknown commodity code: {code}"));
    }
    Ok(code)
}
pub fn resource_code_of_slug(slug: &str) -> Option<i64> {
    RESOURCE_SLUGS.iter().position(|s| *s == slug).map(|i| i as i64)
}
pub fn commodity_code_of_slug(slug: &str) -> Result<i64, String> {
    COMMODITY_SLUGS
        .iter()
        .position(|s| *s == slug)
        .map(|i| i as i64)
        .ok_or_else(|| format!("unknown commodity slug: {slug:?}"))
}

#[derive(Clone, Copy)]
pub struct EconomyComps {
    pub assigned_node: usize,
    pub carry_capacity: usize,
    pub inventory: usize,
    pub resource_node: usize,
    pub position: usize,
    pub stockpile: usize,
    pub commodity_stockpile: usize,
    pub drop_off: usize,
}

impl EconomyComps {
    pub fn from_world(world: &World) -> EconomyComps {
        let id = |name: &str| world.registry.id_of(name).unwrap_or_else(|_| panic!("registry lacks {name}"));
        EconomyComps {
            assigned_node: id("AssignedNode"),
            carry_capacity: id("CarryCapacity"),
            inventory: id("Inventory"),
            resource_node: id("ResourceNode"),
            position: id("Position"),
            stockpile: id("Stockpile"),
            commodity_stockpile: id("CommodityStockpile"),
            drop_off: id("DropOff"),
        }
    }
}

fn rows(world: &World, component: usize) -> &std::collections::BTreeMap<Eid, Vec<f64>> {
    world.rows_by_component.get(component).expect("registered component")
}
fn rows_mut(world: &mut World, component: usize) -> &mut std::collections::BTreeMap<Eid, Vec<f64>> {
    world.rows_by_component.get_mut(component).expect("registered component")
}
fn is_int(v: f64) -> bool {
    v.is_finite() && v.trunc() == v
}

// ---- resource nodes ------------------------------------------------------------

pub fn spawn_resource_node(
    world: &mut World,
    econ: &EconomyComps,
    tile_x: i64,
    tile_y: i64,
    resource_code: i64,
    amount: i64,
    work_slots: Option<f64>,
) -> Result<Eid, String> {
    if amount <= 0 {
        return Err(format!("resource node amount must be a positive integer, got {amount}"));
    }
    let work_slots = work_slots.unwrap_or(WORK_SLOTS_PER_NODE);
    if !is_int(work_slots) || work_slots < 0.0 {
        return Err(format!("resource node work slots must be a non-negative integer, got {work_slots}"));
    }
    require_resource_code(resource_code)?;
    let eid = world.spawn();
    world.set_values(econ.position, eid, &[tile_x as f64 + 0.5, tile_y as f64 + 0.5])?;
    world.set_values(econ.resource_node, eid, &[resource_code as f64, amount as f64, work_slots])?;
    Ok(eid)
}

pub fn resource_node_row<'a>(world: &'a World, econ: &EconomyComps, eid: Eid) -> Option<&'a Vec<f64>> {
    rows(world, econ.resource_node).get(&eid)
}

// ---- carry + inventory -----------------------------------------------------------

pub fn ensure_carry_capacity(world: &mut World, econ: &EconomyComps, eid: Eid, capacity: f64) -> Result<(), String> {
    if !is_int(capacity) || capacity <= 0.0 {
        return Err(format!("carry capacity must be a positive integer, got {capacity}"));
    }
    rows_mut(world, econ.carry_capacity).entry(eid).or_insert_with(|| vec![capacity]);
    Ok(())
}
pub fn carry_capacity(world: &World, econ: &EconomyComps, eid: Eid) -> f64 {
    rows(world, econ.carry_capacity).get(&eid).expect("carry capacity row")[0]
}
pub fn inventory(world: &World, econ: &EconomyComps, eid: Eid) -> Option<(f64, f64)> {
    rows(world, econ.inventory).get(&eid).map(|r| (r[0], r[1]))
}
pub fn ensure_inventory(world: &mut World, econ: &EconomyComps, eid: Eid, resource_code: i64) -> Result<(), String> {
    require_resource_code(resource_code)?;
    rows_mut(world, econ.inventory).entry(eid).or_insert_with(|| vec![resource_code as f64, 0.0]);
    Ok(())
}
pub fn set_inventory(world: &mut World, econ: &EconomyComps, eid: Eid, resource_code: i64, amount: f64) -> Result<(), String> {
    require_resource_code(resource_code)?;
    if !is_int(amount) || amount < 0.0 {
        return Err(format!("carried amount must be a non-negative integer, got {amount}"));
    }
    let row = rows_mut(world, econ.inventory).get_mut(&eid).ok_or_else(|| format!("entity {eid} has no Inventory row"))?;
    row[0] = resource_code as f64;
    row[1] = amount;
    Ok(())
}

// ---- assignment ------------------------------------------------------------

pub fn assign_node(world: &mut World, econ: &EconomyComps, worker: Eid, node: Eid) -> Result<(), String> {
    if node < 1 {
        return Err(format!("assigned node entity id must be a positive integer, got {node}"));
    }
    rows_mut(world, econ.assigned_node).insert(worker, vec![node as f64, -1.0]);
    Ok(())
}
pub fn assigned_node(world: &World, econ: &EconomyComps, worker: Eid) -> Option<(Eid, f64)> {
    rows(world, econ.assigned_node).get(&worker).map(|r| (r[0] as Eid, r[1]))
}
pub fn clear_assigned_node(world: &mut World, econ: &EconomyComps, worker: Eid) -> bool {
    rows_mut(world, econ.assigned_node).remove(&worker).is_some()
}

// ---- stockpile ---------------------------------------------------------------

fn owner_row_index(world: &World, component: usize, player_id: f64) -> Option<Eid> {
    rows(world, component).iter().find(|(_, r)| r[0] == player_id).map(|(e, _)| *e)
}
fn require_player(player_id: f64) -> Result<(), String> {
    if !is_int(player_id) || player_id < 0.0 {
        return Err(format!("player id must be a non-negative integer, got {player_id}"));
    }
    Ok(())
}

pub fn create_player_stockpile(
    world: &mut World,
    econ: &EconomyComps,
    player_id: f64,
    initial_amounts: Option<&[f64]>,
) -> Result<Eid, String> {
    require_player(player_id)?;
    if let Some(amounts) = initial_amounts {
        if amounts.len() != RESOURCE_COUNT {
            return Err(format!("initial amounts must hold exactly {RESOURCE_COUNT} entries, got {}", amounts.len()));
        }
        for a in amounts {
            if !is_int(*a) || *a < 0.0 {
                return Err(format!("initial amounts must be non-negative integers, got {a}"));
            }
        }
    }
    let eid = world.spawn();
    let mut row = vec![player_id];
    row.extend_from_slice(initial_amounts.unwrap_or(&[0.0; RESOURCE_COUNT]));
    world.set_values(econ.stockpile, eid, &row)?;
    Ok(eid)
}

pub fn create_commodity_stockpile(world: &mut World, econ: &EconomyComps, player_id: f64) -> Result<(), String> {
    let owner = owner_row_index(world, econ.stockpile, player_id)
        .ok_or_else(|| format!("player {player_id} has no stockpile entity"))?;
    let mut row = vec![player_id];
    row.extend(std::iter::repeat(0.0).take(COMMODITY_COUNT));
    world.set_values(econ.commodity_stockpile, owner, &row)
}

pub fn accepted_resource_mask(codes: &[i64]) -> Result<f64, String> {
    let mut mask = 0i64;
    for code in codes {
        require_resource_code(*code)?;
        mask |= 1 << code;
    }
    Ok(mask as f64)
}

pub fn create_drop_off(
    world: &mut World,
    econ: &EconomyComps,
    x: f64,
    y: f64,
    player_id: f64,
    accepted_codes: Option<&[i64]>,
) -> Result<Eid, String> {
    if !x.is_finite() || !y.is_finite() {
        return Err(format!("drop-off point needs finite coordinates, got ({x}, {y})"));
    }
    let mask = match accepted_codes {
        None => ALL_RESOURCES_MASK,
        Some(codes) => accepted_resource_mask(codes)?,
    };
    let eid = world.spawn();
    world.set_values(econ.position, eid, &[x, y])?;
    world.set_values(econ.drop_off, eid, &[player_id, mask])?;
    Ok(eid)
}

pub fn drop_off_owner(world: &World, econ: &EconomyComps, eid: Eid) -> Option<f64> {
    rows(world, econ.drop_off).get(&eid).map(|r| r[0])
}
pub fn drop_off_accepts(world: &World, econ: &EconomyComps, eid: Eid, resource_code: i64) -> Result<bool, String> {
    let Some(r) = rows(world, econ.drop_off).get(&eid) else { return Ok(false) };
    require_resource_code(resource_code)?;
    Ok((r[1] as i64 & (1 << resource_code)) != 0)
}

pub fn deposit(world: &mut World, econ: &EconomyComps, player_id: f64, resource_code: i64, amount: f64) -> Result<(), String> {
    require_resource_code(resource_code)?;
    if !is_int(amount) || amount <= 0.0 {
        return Err(format!("deposit amount must be a positive integer, got {amount}"));
    }
    let eid = owner_row_index(world, econ.stockpile, player_id)
        .ok_or_else(|| format!("player {player_id} has no stockpile entity"))?;
    rows_mut(world, econ.stockpile).get_mut(&eid).unwrap()[resource_code as usize + 1] += amount;
    Ok(())
}

pub fn credit_resource_slug(world: &mut World, econ: &EconomyComps, player_id: f64, slug: &str, amount: f64) -> Result<(), String> {
    let code = resource_code_of_slug(slug).ok_or_else(|| format!("unknown resource slug: {slug}"))?;
    deposit(world, econ, player_id, code, amount)
}

pub fn stockpile_amounts(world: &World, econ: &EconomyComps, player_id: f64) -> Vec<f64> {
    let eid = owner_row_index(world, econ.stockpile, player_id)
        .unwrap_or_else(|| panic!("player {player_id} has no stockpile entity"));
    rows(world, econ.stockpile)[&eid][1..].to_vec()
}

pub fn total_stockpiled(world: &World, econ: &EconomyComps, resource_code: i64) -> Result<f64, String> {
    require_resource_code(resource_code)?;
    Ok(rows(world, econ.stockpile).values().map(|r| r[resource_code as usize + 1]).sum())
}

// ---- commodities ---------------------------------------------------------------

pub fn deposit_commodity(world: &mut World, econ: &EconomyComps, player_id: f64, code: i64, amount: f64) -> Result<(), String> {
    require_commodity_code(code)?;
    if !is_int(amount) || amount <= 0.0 {
        return Err(format!("commodity deposit amount must be a positive integer, got {amount}"));
    }
    let eid = owner_row_index(world, econ.commodity_stockpile, player_id)
        .ok_or_else(|| format!("player {player_id} has no commodity stockpile"))?;
    rows_mut(world, econ.commodity_stockpile).get_mut(&eid).unwrap()[code as usize + 1] += amount;
    Ok(())
}

pub fn withdraw_commodity(world: &mut World, econ: &EconomyComps, player_id: f64, code: i64, amount: f64) -> Result<(), String> {
    require_commodity_code(code)?;
    if !is_int(amount) || amount <= 0.0 {
        return Err(format!("commodity withdraw amount must be a positive integer, got {amount}"));
    }
    let eid = owner_row_index(world, econ.commodity_stockpile, player_id)
        .ok_or_else(|| format!("player {player_id} has no commodity stockpile"))?;
    let row = rows_mut(world, econ.commodity_stockpile).get_mut(&eid).unwrap();
    let held = row[code as usize + 1];
    if held < amount {
        return Err(format!("cannot withdraw {amount} {}, commodity stockpile holds {held}", COMMODITY_SLUGS[code as usize]));
    }
    row[code as usize + 1] -= amount;
    Ok(())
}

pub fn commodity_amount(world: &World, econ: &EconomyComps, player_id: f64, code: i64) -> Result<f64, String> {
    require_commodity_code(code)?;
    let eid = owner_row_index(world, econ.commodity_stockpile, player_id)
        .ok_or_else(|| format!("player {player_id} has no commodity stockpile"))?;
    Ok(rows(world, econ.commodity_stockpile)[&eid][code as usize + 1])
}

pub fn commodity_amount_or_zero(world: &World, econ: &EconomyComps, player_id: f64, code: i64) -> f64 {
    match owner_row_index(world, econ.commodity_stockpile, player_id) {
        Some(eid) => rows(world, econ.commodity_stockpile)[&eid][code as usize + 1],
        None => 0.0,
    }
}

pub fn ledger_amount_of_slug(world: &World, econ: &EconomyComps, player_id: f64, slug: &str) -> Result<f64, String> {
    if let Some(code) = resource_code_of_slug(slug) {
        return Ok(stockpile_amounts(world, econ, player_id)[code as usize]);
    }
    commodity_amount(world, econ, player_id, commodity_code_of_slug(slug)?)
}

pub struct LedgerEntry {
    pub def_id: String,
    pub qty: f64,
}

fn check_shortfall(world: &World, econ: &EconomyComps, player_id: f64, entries: &[LedgerEntry]) -> Result<Option<(f64, String, f64)>, String> {
    for entry in entries {
        if !is_int(entry.qty) || entry.qty <= 0.0 {
            return Err("ledger debit qty must be a positive integer".into());
        }
        let held = ledger_amount_of_slug(world, econ, player_id, &entry.def_id)?;
        if held < entry.qty {
            return Ok(Some((entry.qty, entry.def_id.clone(), held)));
        }
    }
    Ok(None)
}

pub fn debit_ledger_slugs(world: &mut World, econ: &EconomyComps, player_id: f64, entries: &[LedgerEntry], what: &str) -> Result<(), String> {
    if let Some((qty, name, held)) = check_shortfall(world, econ, player_id, entries)? {
        return Err(format!("cannot afford {what}: needs {qty} {name}, stockpile holds {held}"));
    }
    // Aggregate duplicate slugs before mutating (TS resolves rows per
    // entry and subtracts sequentially; the pre-check used per-entry
    // held amounts, so duplicate shortfalls are a TS-visible edge we
    // preserve only where the pre-check semantics require).
    for entry in entries {
        if let Some(code) = resource_code_of_slug(&entry.def_id) {
            let eid = owner_row_index(world, econ.stockpile, player_id).expect("stockpile row");
            rows_mut(world, econ.stockpile).get_mut(&eid).unwrap()[code as usize + 1] -= entry.qty;
        } else {
            let code = commodity_code_of_slug(&entry.def_id)?;
            let eid = owner_row_index(world, econ.commodity_stockpile, player_id).expect("commodity row");
            rows_mut(world, econ.commodity_stockpile).get_mut(&eid).unwrap()[code as usize + 1] -= entry.qty;
        }
    }
    Ok(())
}

pub fn can_debit_ledger_slugs(world: &World, econ: &EconomyComps, player_id: f64, entries: &[LedgerEntry]) -> bool {
    // TS throws on malformed entries even from the predicate; malformed
    // input here reads as not-affordable-free input, so surface as false
    // only on shortfall, panicking on programming errors like TS.
    match check_shortfall(world, econ, player_id, entries) {
        Ok(None) => true,
        Ok(Some(_)) => false,
        Err(e) => panic!("{e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::movement::define_sim_components;

    fn fixture_world() -> (World, EconomyComps) {
        let mut world = World::new(1);
        define_sim_components(&mut world);
        let econ = EconomyComps::from_world(&world);
        (world, econ)
    }

    #[test]
    fn stockpile_deposit_and_masks() {
        let (mut world, econ) = fixture_world();
        create_player_stockpile(&mut world, &econ, 0.0, Some(&[100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])).unwrap();
        deposit(&mut world, &econ, 0.0, 1, 25.0).unwrap();
        assert_eq!(stockpile_amounts(&world, &econ, 0.0), vec![100.0, 25.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        assert!(deposit(&mut world, &econ, 0.0, 1, 0.0).is_err());
        assert!(deposit(&mut world, &econ, 9.0, 1, 1.0).is_err(), "no ledger for player 9");
        let depot = create_drop_off(&mut world, &econ, 5.5, 5.5, 0.0, Some(&[1])).unwrap();
        assert!(drop_off_accepts(&world, &econ, depot, 1).unwrap());
        assert!(!drop_off_accepts(&world, &econ, depot, 0).unwrap());
        assert_eq!(drop_off_owner(&world, &econ, depot), Some(0.0));
    }

    #[test]
    fn commodity_ledger_and_atomic_debit() {
        let (mut world, econ) = fixture_world();
        create_player_stockpile(&mut world, &econ, 0.0, Some(&[0.0, 50.0, 0.0, 0.0, 0.0, 0.0, 0.0])).unwrap();
        create_commodity_stockpile(&mut world, &econ, 0.0).unwrap();
        deposit_commodity(&mut world, &econ, 0.0, 0, 4.0).unwrap();
        let short = vec![
            LedgerEntry { def_id: "wood".into(), qty: 10.0 },
            LedgerEntry { def_id: "planks".into(), qty: 9.0 },
        ];
        assert!(debit_ledger_slugs(&mut world, &econ, 0.0, &short, "test").is_err());
        // Atomic: nothing subtracted on shortfall.
        assert_eq!(stockpile_amounts(&world, &econ, 0.0)[1], 50.0);
        assert_eq!(commodity_amount(&world, &econ, 0.0, 0).unwrap(), 4.0);
        let ok = vec![LedgerEntry { def_id: "wood".into(), qty: 10.0 }];
        debit_ledger_slugs(&mut world, &econ, 0.0, &ok, "test").unwrap();
        assert_eq!(stockpile_amounts(&world, &econ, 0.0)[1], 40.0);
        assert!(withdraw_commodity(&mut world, &econ, 0.0, 0, 99.0).is_err());
    }

    #[test]
    fn nodes_inventory_assignment() {
        let (mut world, econ) = fixture_world();
        let node = spawn_resource_node(&mut world, &econ, 3, 4, 1, 100, None).unwrap();
        assert_eq!(resource_node_row(&world, &econ, node).unwrap(), &vec![1.0, 100.0, 8.0]);
        let worker = world.spawn();
        ensure_carry_capacity(&mut world, &econ, worker, DEFAULT_CARRY_CAPACITY).unwrap();
        ensure_inventory(&mut world, &econ, worker, 1).unwrap();
        set_inventory(&mut world, &econ, worker, 1, 7.0).unwrap();
        assert_eq!(inventory(&world, &econ, worker), Some((1.0, 7.0)));
        assign_node(&mut world, &econ, worker, node).unwrap();
        assert_eq!(assigned_node(&world, &econ, worker), Some((node, -1.0)));
        assert!(clear_assigned_node(&mut world, &econ, worker));
        assert_eq!(assigned_node(&world, &econ, worker), None);
    }
}
