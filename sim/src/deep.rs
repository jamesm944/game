//! Deep-sim personality layer, clean-room port of the Dwarf Fortress
//! design documented in docs/research/df-reverse-engineering-mood-thoughts.md
//! (#190). Shapes/constants mirror df-structures (Zlib): facet array,
//! need focus (satisfy -> 400, unmet below -999), 8-slot short-term memory
//! ring, two-timescale stress with 0..806400 history timers. All gains are
//! our own deterministic integers (DF's exact formulas are unknown).
use serde::{Deserialize, Serialize};

pub const FACETS: usize = 8;
pub const F_STRESS_VULN: usize = 0;
pub const F_CHEER: usize = 1;
pub const F_ANGER: usize = 2;
pub const F_ANXIETY: usize = 3;
pub const F_DEPRESSION: usize = 4;
pub const F_EXCITEMENT: usize = 5;
pub const F_ART: usize = 6;
pub const F_ABSTRACT: usize = 7;

pub const NEEDS: usize = 4;
pub const N_OCCUPIED: usize = 0; // df: StayOccupied
pub const N_EAT: usize = 1; // df: EatGoodMeal
pub const N_SOCIAL: usize = 2; // df: Socialize
pub const N_EASY: usize = 3; // df: TakeItEasy

// Circumstance (thought) kinds: subset of df unit_thought_type, own ids.
pub const C_NONE: i32 = 0;
pub const C_HUNGRY: i32 = 1;
pub const C_ATE_MEAL: i32 = 2;
pub const C_DELIVERED: i32 = 3;
pub const C_UNMET_NEED: i32 = 4;
pub const C_SOCIALIZED: i32 = 5;

pub const FOCUS_SATISFIED: i32 = 400;
pub const FOCUS_UNMET: i32 = -999;
pub const TIMER_MAX: i32 = 806_400;
pub const STRESS_MIN: i32 = -10_000;
pub const STRESS_MAX: i32 = 30_000;
pub const MEM_SLOTS: usize = 8;

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Debug, Default)]
pub struct MemSlot {
    pub circ: i32,
    pub strength: i32,
    pub tick: u64,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct DeepState {
    pub facets: [i16; FACETS],
    pub focus: [i32; NEEDS],
    pub need_rate: [i32; NEEDS],
    pub stress: i32,
    pub longterm_stress: i32,
    pub time_without_distress: i32,
    pub time_without_eustress: i32,
    pub mem: [MemSlot; MEM_SLOTS],
    pub mem_next: u8,
}

impl Default for DeepState {
    fn default() -> Self {
        Self::new(0)
    }
}

fn hash(id: u32, salt: u32) -> u32 {
    let mut h = id.wrapping_mul(0x9e37_79b1) ^ salt.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h.wrapping_mul(0xc2b2_ae35) ^ (h >> 16)
}

impl DeepState {
    pub fn new(id: u32) -> Self {
        let mut facets = [0i16; FACETS];
        for (i, f) in facets.iter_mut().enumerate() {
            *f = (hash(id, 100 + i as u32) % 101) as i16; // 0..=100, df-style facet scale
        }
        let mut need_rate = [0i32; NEEDS];
        for (i, r) in need_rate.iter_mut().enumerate() {
            *r = 1 + (hash(id, 200 + i as u32) % 3) as i32; // 1..=3
        }
        DeepState {
            facets,
            focus: [200; NEEDS],
            need_rate,
            stress: 0,
            longterm_stress: 0,
            time_without_distress: 0,
            time_without_eustress: 0,
            mem: [MemSlot::default(); MEM_SLOTS],
            mem_next: 0,
        }
    }

    fn facet_scale(&self, facet: usize, base: i32) -> i32 {
        // Facet 50 = neutral (x1); 0 -> x0.5, 100 -> x1.5, integer math.
        base * (50 + self.facets[facet] as i32) / 100
    }

    pub fn record(&mut self, circ: i32, strength: i32, tick: u64) {
        let slot = self.mem_next as usize % MEM_SLOTS;
        self.mem[slot] = MemSlot { circ, strength, tick };
        self.mem_next = ((slot + 1) % MEM_SLOTS) as u8;
    }

    pub fn distress(&mut self, base: i32, circ: i32, tick: u64) {
        let amt = self.facet_scale(F_STRESS_VULN, base).max(0);
        self.stress = (self.stress + amt).clamp(STRESS_MIN, STRESS_MAX);
        self.time_without_distress = 0;
        self.record(circ, amt, tick);
    }

    pub fn eustress(&mut self, base: i32, circ: i32, tick: u64) {
        let amt = self.facet_scale(F_CHEER, base).max(0);
        self.stress = (self.stress - amt).clamp(STRESS_MIN, STRESS_MAX);
        self.time_without_eustress = 0;
        self.record(circ, -amt, tick);
    }

    pub fn satisfy(&mut self, need: usize) {
        self.focus[need] = FOCUS_SATISFIED;
    }

    pub fn nourish(&mut self, need: usize, amount: i32) {
        self.focus[need] = (self.focus[need] + amount).min(FOCUS_SATISFIED);
    }

    pub fn has_unmet(&self) -> bool {
        self.focus.iter().any(|&f| f < FOCUS_UNMET)
    }

    /// One cadence step (called on the entity-phase cadence in lib.rs):
    /// decay need focus, stress from unmet needs, drift stress toward the
    /// long-term baseline at a rate the history timers modulate, and creep
    /// the baseline toward sustained stress.
    pub fn cadence(&mut self, tick: u64) {
        for i in 0..NEEDS {
            self.focus[i] -= 1;
            if self.focus[i] < 0 {
                self.focus[i] -= self.need_rate[i];
            }
        }
        if self.has_unmet() {
            self.distress(6, C_UNMET_NEED, tick);
        } else {
            self.time_without_distress = (self.time_without_distress + 30).min(TIMER_MAX);
        }
        self.time_without_eustress = (self.time_without_eustress + 30).min(TIMER_MAX);
        // Drift current stress toward long-term baseline; calmer history
        // (higher time_without_distress) drifts down faster when stressed.
        let diff = self.longterm_stress - self.stress;
        if diff != 0 {
            let speed = 1 + self.time_without_distress / 10_000;
            let step = diff.clamp(-speed, speed);
            self.stress = (self.stress + step).clamp(STRESS_MIN, STRESS_MAX);
        }
        // Baseline creeps 1 step toward sustained levels every cadence.
        let gap = self.stress - self.longterm_stress;
        if gap > 256 {
            self.longterm_stress += 1;
        } else if gap < -256 {
            self.longterm_stress -= 1;
        }
    }

    /// Presentation band 0..=6 (binary exposes 7 BUTTON_STRESS bands;
    /// cut-points are ours).
    pub fn stress_band(&self) -> u8 {
        match self.stress {
            i32::MIN..=-1 => 0,
            0..=999 => 1,
            1000..=2999 => 2,
            3000..=5999 => 3,
            6000..=9999 => 4,
            10000..=14999 => 5,
            _ => 6,
        }
    }

    /// Derived morale on the legacy 0..=10000 presentation scale.
    pub fn morale(&self) -> i32 {
        (10_000 - self.stress.clamp(0, 20_000) / 2).clamp(0, 10_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deterministic_personality() {
        assert_eq!(DeepState::new(7), DeepState::new(7));
        assert_ne!(DeepState::new(7).facets, DeepState::new(8).facets);
    }
    #[test]
    fn satisfy_resets_focus_to_df_constant() {
        let mut d = DeepState::new(1);
        d.focus[N_EAT] = -5000;
        d.satisfy(N_EAT);
        assert_eq!(d.focus[N_EAT], 400);
    }
    #[test]
    fn unmet_need_raises_stress_and_records_memory() {
        let mut d = DeepState::new(2);
        d.focus = [-2000; NEEDS];
        let before = d.stress;
        d.cadence(10);
        assert!(d.stress > before);
        assert!(d.mem.iter().any(|m| m.circ == C_UNMET_NEED));
        assert_eq!(d.time_without_distress, 0);
    }
    #[test]
    fn stress_drifts_toward_longterm() {
        let mut d = DeepState::new(3);
        d.stress = 5000;
        d.longterm_stress = 0;
        for t in 0..50u64 {
            d.focus = [400; NEEDS];
            d.cadence(t);
        }
        assert!(d.stress < 5000, "stress={}", d.stress);
    }
    #[test]
    fn vulnerable_facet_amplifies_distress() {
        let mut lo = DeepState::new(4);
        lo.facets[F_STRESS_VULN] = 0;
        let mut hi = DeepState::new(4);
        hi.facets[F_STRESS_VULN] = 100;
        lo.distress(100, C_HUNGRY, 0);
        hi.distress(100, C_HUNGRY, 0);
        assert_eq!((lo.stress, hi.stress), (50, 150));
    }
    #[test]
    fn memory_ring_wraps_at_eight() {
        let mut d = DeepState::new(5);
        for i in 0..10u64 {
            d.record(C_DELIVERED, i as i32, i);
        }
        assert_eq!(d.mem_next, 2);
        assert_eq!(d.mem[0].strength, 8);
        assert_eq!(d.mem[1].strength, 9);
    }
}
