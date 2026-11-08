//! Deterministic transcendental-free trig (SPEC §2.1), op-for-op port
//! of `src/sim/core/trig.ts`. Fixed polynomial evaluations over IEEE
//! basic ops only — bit-identical to the TS originals.

pub const TWO_PI: f64 = 2.0 * std::f64::consts::PI;
pub const HALF_PI: f64 = std::f64::consts::PI / 2.0;
const PI: f64 = std::f64::consts::PI;

pub fn wrap_angle(x: f64) -> f64 {
    x - TWO_PI * ((x + PI) / TWO_PI).floor()
}

pub fn angle_delta(from: f64, to: f64) -> f64 {
    wrap_angle(to - from)
}

pub fn det_sin(x: f64) -> f64 {
    let mut y = x - TWO_PI * ((x + PI) / TWO_PI).floor();
    let mut negative = false;
    if y < 0.0 {
        negative = true;
        y = -y;
    }
    if y > HALF_PI {
        y = PI - y;
    }
    let y2 = y * y;
    let s = y
        * (1.0
            + y2
                * (-1.0 / 6.0
                    + y2
                        * (1.0 / 120.0
                            + y2 * (-1.0 / 5040.0 + y2 * (1.0 / 362880.0 + y2 * (-1.0 / 39916800.0))))));
    if negative { -s } else { s }
}

pub fn det_cos(x: f64) -> f64 {
    det_sin(HALF_PI - x)
}

const ATAN_C0: f64 = 0.7853981694;
const ATAN_C1: f64 = -0.2145007798;
const ATAN_C2: f64 = 0.08533227471;
const ATAN_C3: f64 = -0.03253083455;
const ATAN_C4: f64 = 0.007894486004;

fn det_atan_unit(z: f64) -> f64 {
    let z2 = z * z;
    z * (ATAN_C0 + z2 * (ATAN_C1 + z2 * (ATAN_C2 + z2 * (ATAN_C3 + z2 * ATAN_C4))))
}

pub fn det_atan2(y: f64, x: f64) -> f64 {
    if y == 0.0 && x == 0.0 {
        return 0.0;
    }
    let ax = if x < 0.0 { -x } else { x };
    let ay = if y < 0.0 { -y } else { y };
    let mut r = if ay <= ax { det_atan_unit(ay / ax) } else { HALF_PI - det_atan_unit(ax / ay) };
    if x < 0.0 {
        r = PI - r;
    }
    if y < 0.0 { -r } else { r }
}

pub struct SinCosLut {
    pub size: usize,
    pub sin: Vec<f64>,
    pub cos: Vec<f64>,
}

pub fn build_sin_cos_lut(size: usize) -> SinCosLut {
    assert!(size >= 2, "LUT size must be an integer ≥ 2, got {size}");
    let mut sin = vec![0.0; size];
    let mut cos = vec![0.0; size];
    for i in 0..size {
        let angle = (TWO_PI * i as f64) / size as f64;
        sin[i] = det_sin(angle);
        cos[i] = det_cos(angle);
    }
    SinCosLut { size, sin, cos }
}
