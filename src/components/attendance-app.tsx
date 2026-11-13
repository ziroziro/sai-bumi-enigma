"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Html5Qrcode } from "html5-qrcode";
import {
  ATTENDANCE_ROSTER,
  ATTENDANCE_TARGET_LOCATION,
  calculateDistanceMeters,
  findMemberByBarcode,
  type AttendanceMember,
} from "@/domain/attendance";
import { Icon } from "./icon";

const ATTENDANCE_STORAGE_KEY = "sai_bumi_enigma_attendance_records";
const DEVICE_LOCK_KEY = "sai_bumi_enigma_device_attendance_lock";

interface DeviceLock {
  nik: string;
  nama: string;
  timestamp: string;
}

function getStoredRecords(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(ATTENDANCE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function saveStoredRecords(records: Record<string, string>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(ATTENDANCE_STORAGE_KEY, JSON.stringify(records));
  } catch {
    // ignore
  }
}

function getStoredDeviceLock(): DeviceLock | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(DEVICE_LOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.nik === "string" && typeof parsed.nama === "string") {
      return parsed as DeviceLock;
    }
    return null;
  } catch {
    return null;
  }
}

function saveStoredDeviceLock(lock: DeviceLock) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(DEVICE_LOCK_KEY, JSON.stringify(lock));
  } catch {
    // ignore
  }
}

function playScanBeep() {
  if (typeof window === "undefined") return;
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1046.5, ctx.currentTime);
    osc.frequency.setValueAtTime(1318.5, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.22);
  } catch {
    // ignore
  }
}

function playTypingClick() {
  if (typeof window === "undefined") return;
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(650 + Math.random() * 300, ctx.currentTime);
    gain.gain.setValueAtTime(0.02, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.03);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.03);
  } catch {
    // ignore
  }
}

function playRadarSweepSound() {
  if (typeof window === "undefined") return;
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch {
    // ignore
  }
}

const emptySubscribe = () => () => {};

export function AttendanceApp() {
  // Hydration-safe client mount status via React 19 standard useSyncExternalStore
  const isMounted = useSyncExternalStore(emptySubscribe, () => true, () => false);

  // Localhost environment check (Hanya izinkan mode simulasi di localhost, hydration-safe)
  const isLocalhost = useSyncExternalStore(
    emptySubscribe,
    () => {
      if (typeof window === "undefined") return false;
      const host = window.location.hostname;
      return (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host.endsWith(".local") ||
        host.startsWith("192.168.") ||
        host.startsWith("10.") ||
        host === "0.0.0.0"
      );
    },
    () => false
  );

  // Attendance Records: NIK -> ISO timestamp
  const [, setRecords] = useState<Record<string, string>>({});

  // Device Lock State (Silent 1 device = 1 user)
  const [deviceLock, setDeviceLock] = useState<DeviceLock | null>(null);

  // Scanner state
  const [scanError, setScanError] = useState<string | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  // Html5Qrcode Scanner instance ref & in-flight guard
  const html5QrCodeRef = useRef<Html5Qrcode | null>(null);
  const isProcessingScanRef = useRef(false);

  // Geolocation state (PT. Tunas Dwipa Matra - TDM)
  const [userLocation, setUserLocation] = useState<{
    latitude: number;
    longitude: number;
    accuracy: number;
    distanceMeters: number;
    isWithinRange: boolean;
    timestamp: number;
  } | null>(null);
  const [locationStatus, setLocationStatus] = useState<
    "idle" | "checking" | "granted" | "denied" | "out_of_range"
  >("idle");
  const [locationError, setLocationError] = useState<string | null>(null);

  // Detect live device GPS location
  const detectDeviceLocation = useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined" || !("geolocation" in navigator)) {
      setLocationStatus("denied");
      setLocationError("Browser atau perangkat Anda tidak mendukung fitur deteksi lokasi GPS.");
      return false;
    }

    setLocationStatus("checking");
    setLocationError(null);

    return new Promise<boolean>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;
          const distance = calculateDistanceMeters(
            latitude,
            longitude,
            ATTENDANCE_TARGET_LOCATION.latitude,
            ATTENDANCE_TARGET_LOCATION.longitude
          );
          const withinRange = distance <= ATTENDANCE_TARGET_LOCATION.maxRadiusMeters;

          setUserLocation({
            latitude,
            longitude,
            accuracy: Math.round(accuracy || 0),
            distanceMeters: distance,
            isWithinRange: withinRange,
            timestamp: Date.now(),
          });

          if (withinRange) {
            setLocationStatus("granted");
            resolve(true);
          } else {
            setLocationStatus("out_of_range");
            setLocationError(
              `Perangkat Anda terdeteksi berjarak ${distance.toLocaleString(
                "id-ID"
              )} meter dari PT. Tunas Dwipa Matra (TDM). Absensi HANYA DAPAT DILAKUKAN di lokasi acara (radius maksimal ${
                ATTENDANCE_TARGET_LOCATION.maxRadiusMeters
              }m).`
            );
            resolve(false);
          }
        },
        (err) => {
          let msg = "Akses lokasi diperlukan untuk memverifikasi kehadiran di area acara PT. Tunas Dwipa Matra.";
          if (err.code === err.PERMISSION_DENIED) {
            msg = "Izin lokasi GPS ditolak oleh browser/perangkat. Harap aktifkan izin lokasi di pengaturan browser agar dapat absensi.";
          } else if (err.code === err.POSITION_UNAVAILABLE) {
            msg = "Sinyal GPS perangkat tidak terdeteksi. Pastikan GPS/Location perangkat telah diaktifkan.";
          } else if (err.code === err.TIMEOUT) {
            msg = "Waktu permintaan lokasi GPS habis. Silakan klik 'Deteksi Ulang GPS Perangkat'.";
          }
          setLocationStatus("denied");
          setLocationError(msg);
          resolve(false);
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
      );
    });
  }, []);

  // Run device location detection automatically on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      void detectDeviceLocation();
    }, 120);
    return () => clearTimeout(timer);
  }, [detectDeviceLocation]);

  // Check GPS Location - Strict Enforcement
  const verifyLocation = useCallback(
    async (allowSimulationBypass = false): Promise<boolean> => {
      // Allow bypass ONLY if in localhost and simulation mode explicitly checks bypass
      if (allowSimulationBypass && isLocalhost) {
        return true;
      }

      // If userLocation was determined very recently (< 15 seconds ago) and is within range
      if (
        userLocation &&
        userLocation.isWithinRange &&
        Date.now() - userLocation.timestamp < 15000
      ) {
        return true;
      }

      // Otherwise re-check live GPS coordinates
      return await detectDeviceLocation();
    },
    [isLocalhost, userLocation, detectDeviceLocation]
  );

  // Magnifying glass radar searching state
  const [isSearchingAgent, setIsSearchingAgent] = useState(false);
  const [searchPhaseText, setSearchPhaseText] = useState("");

  // Active scanned member & Typewriter animation state on Detective ID Card
  const [scannedMember, setScannedMember] = useState<AttendanceMember | null>(null);
  const [scannedTime, setScannedTime] = useState<string | null>(null);
  const [typedNameCount, setTypedNameCount] = useState<number>(0);
  const [revealedFieldsCount, setRevealedFieldsCount] = useState<number>(0);
  const typingTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Simulation Mode State (Khusus Pengujian / Testing)
  const [isSimulationOpen, setIsSimulationOpen] = useState(false);
  const [simulationNik, setSimulationNik] = useState("");
  const [simulationBypassGps, setSimulationBypassGps] = useState(true);
  const [simulationBypassDeviceLock, setSimulationBypassDeviceLock] = useState(true);

  // Sync attendance records from server continuously
  useEffect(() => {
    async function syncRecords() {
      try {
        const storedRecs = getStoredRecords();
        setRecords(storedRecs);

        const lock = getStoredDeviceLock();
        if (lock) {
          setDeviceLock(lock);
          const member = findMemberByBarcode(lock.nik);
          if (member) {
            setScannedMember((prev) => prev ?? member);
            setScannedTime((prev) => prev ?? lock.timestamp);
            setTypedNameCount((prev) => (prev === 0 ? member.nama.length : prev));
            setRevealedFieldsCount((prev) => (prev === 0 ? 6 : prev));
          }
        }

        const res = await fetch("/api/attendance", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (data.records && typeof data.records === "object") {
            const serverRecords: Record<string, string> = data.records;
            const lastResetAt: string | null = data.lastResetAt ?? null;
            const deletedNiks: string[] = Array.isArray(data.deletedNiks) ? data.deletedNiks : [];

            const currentLock = getStoredDeviceLock();

            // Check if this device lock was explicitly reset or deleted by admin:
            let isLockInvalidated = false;
            if (currentLock) {
              // 1. If admin reset ALL attendance after this device checked in:
              if (lastResetAt && new Date(lastResetAt).getTime() > new Date(currentLock.timestamp).getTime()) {
                isLockInvalidated = true;
              }
              // 2. If admin explicitly deleted this specific participant:
              if (deletedNiks.includes(currentLock.nik)) {
                isLockInvalidated = true;
              }
            }

            if (isLockInvalidated) {
              // Valid admin unlock: clear device lock and reset UI so user can re-attend
              localStorage.removeItem(DEVICE_LOCK_KEY);
              localStorage.removeItem(ATTENDANCE_STORAGE_KEY);
              setDeviceLock(null);
              setScannedMember(null);
              setScannedTime(null);
              setTypedNameCount(0);
              setRevealedFieldsCount(0);
              setRecords(serverRecords);
              saveStoredRecords(serverRecords);
            } else {
              // Merge server records with client local records to guarantee resilience!
              const mergedRecords = { ...getStoredRecords(), ...serverRecords };
              if (currentLock) {
                mergedRecords[currentLock.nik] = mergedRecords[currentLock.nik] || currentLock.timestamp;
                // If server is missing this participant's attendance, heal the server!
                if (!serverRecords[currentLock.nik]) {
                  void fetch("/api/attendance", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ nik: currentLock.nik, timestamp: currentLock.timestamp }),
                  }).catch(() => {});
                }
              }
              setRecords(mergedRecords);
              saveStoredRecords(mergedRecords);
            }
          }
        }
      } catch {
        // use local
      }
    }

    void syncRecords();

    // Re-sync on tab focus or visibility change without continuous loop spamming
    const handleFocusOrVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void syncRecords();
      }
    };

    window.addEventListener("focus", handleFocusOrVisible);
    window.addEventListener("visibilitychange", handleFocusOrVisible);

    return () => {
      window.removeEventListener("focus", handleFocusOrVisible);
      window.removeEventListener("visibilitychange", handleFocusOrVisible);
    };
  }, []);



  // Execute attendance check-in after radar search completes
  const executeAttendanceConfirmation = useCallback(
    (member: AttendanceMember) => {
      const now = new Date();
      const isoStr = now.toISOString();

      // Record attendance locally
      setRecords((prev) => {
        const updated = {
          ...prev,
          [member.nik]: prev[member.nik] || isoStr,
        };
        saveStoredRecords(updated);
        return updated;
      });

      // Sync attendance to server
      void fetch("/api/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nik: member.nik, timestamp: isoStr }),
      }).catch(() => {});

      // Save silent device lock if not already set
      if (!deviceLock) {
        const newLock: DeviceLock = {
          nik: member.nik,
          nama: member.nama,
          timestamp: isoStr,
        };
        setDeviceLock(newLock);
        saveStoredDeviceLock(newLock);
      }

      // Set active scanned member and initiate typewriter animation on ID Card
      setScannedMember(member);
      setScannedTime(isoStr);
      setTypedNameCount(0);
      setRevealedFieldsCount(0);
      playScanBeep();
    },
    [deviceLock]
  );

  // Trigger searching radar animation with magnifying glass
  const triggerSearchAnimation = useCallback(
    (member: AttendanceMember) => {
      setIsSearchingAgent(true);
      setScannedMember(null);
      setSearchPhaseText("MENGAKTIFKAN RADAR ENIGMA...");
      playRadarSweepSound();

      // Phase 1 -> Phase 2 (600ms)
      setTimeout(() => {
        setSearchPhaseText(`MEMINDAI ARSIP KODE DETEKTIF: ${member.nik}...`);
      }, 600);

      // Phase 2 -> Phase 3 (1200ms)
      setTimeout(() => {
        setSearchPhaseText(`IDENTITAS AGEN DITEMUKAN: ${member.nama}`);
      }, 1200);

      // Phase 3 -> Reveal ID Card (1800ms)
      setTimeout(() => {
        setIsSearchingAgent(false);
        executeAttendanceConfirmation(member);
      }, 1800);
    },
    [executeAttendanceConfirmation]
  );

  // Main barcode scanning processing handler
  const handleProcessBarcode = useCallback(
    async (barcodeText: string) => {
      const trimmed = barcodeText.trim();
      if (!trimmed) return;

      const member = findMemberByBarcode(trimmed);
      if (!member) {
        setScanError(`Kode barcode "${trimmed}" tidak cocok dengan daftar barcode peserta resmi.`);
        return;
      }

      setScanError(null);

      // 1. Silent Device Lock Check: 1 Device = 1 User
      let currentLock = getStoredDeviceLock();
      if (currentLock) {
        // Double check against current records: if the lock is no longer in attendance records, it was reset by admin!
        const latestRecords = getStoredRecords();
        if (!latestRecords[currentLock.nik]) {
          localStorage.removeItem(DEVICE_LOCK_KEY);
          currentLock = null;
          setDeviceLock(null);
        }
      }

      if (currentLock && currentLock.nik !== member.nik) {
        setScanError(
          `Perangkat ini sudah digunakan untuk absensi agen lain (${currentLock.nama}). Sesuai ketentuan, 1 device hanya dapat digunakan untuk absensi 1 orang.`
        );
        return;
      }

      // 2. Strict Geolocation Check (Target location PT. Tunas Dwipa Matra - TDM)
      const isSimulationBypassed = isLocalhost && isSimulationOpen && simulationBypassGps;
      const isLocationValid = await verifyLocation(isSimulationBypassed);
      if (!isLocationValid) {
        setScanError(
          locationError ||
            `ABSENSI DITOLAK: Perangkat Anda berada di luar area acara PT. Tunas Dwipa Matra (TDM). Jarak saat ini: ${
              userLocation ? userLocation.distanceMeters.toLocaleString("id-ID") + "m" : "tidak terdeteksi"
            } (Maksimal ${ATTENDANCE_TARGET_LOCATION.maxRadiusMeters}m).`
        );
        return;
      }

      // Otomatis matikan kamera setelah pemindaian berhasil diverifikasi
      setIsCameraActive(false);

      // Arahkan pandangan secara mulus ke radar pencarian & kartu identitas
      if (typeof window !== "undefined") {
        setTimeout(() => {
          const resultElem = document.querySelector(".scanner-result-area");
          if (resultElem) {
            resultElem.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }, 50);
      }

      // 3. Trigger magnifying glass radar search animation
      triggerSearchAnimation(member);
    },
    [
      isLocalhost,
      isSimulationOpen,
      simulationBypassGps,
      verifyLocation,
      locationError,
      userLocation,
      triggerSearchAnimation,
    ]
  );

  // Handle Simulation NIK Submission (Hanya di Localhost / Testing)
  const handleSimulateNikSubmit = useCallback(
    async (e?: React.FormEvent, explicitNik?: string) => {
      if (e) e.preventDefault();
      if (!isLocalhost) return;

      const targetNik = (explicitNik ?? simulationNik).trim();
      if (!targetNik) return;

      const member = findMemberByBarcode(targetNik);
      if (!member) {
        setScanError(`[SIMULASI] NIK / Nama "${targetNik}" tidak ditemukan dalam daftar peserta resmi.`);
        return;
      }

      setScanError(null);

      // Check device lock unless bypassed for simulation
      if (!simulationBypassDeviceLock) {
        const currentLock = getStoredDeviceLock();
        if (currentLock && currentLock.nik !== member.nik) {
          setScanError(
            `[SIMULASI] Perangkat ini sudah terkunci untuk agen lain (${currentLock.nama}). Centang "Bypass Kunci 1 Perangkat" untuk menguji agen lain.`
          );
          return;
        }
      }

      // Check GPS location unless bypassed for simulation
      const isLocationValid = await verifyLocation(simulationBypassGps);
      if (!isLocationValid) {
        setScanError(
          locationError ||
            `ABSENSI DITOLAK: Anda berada di luar area acara PT. Tunas Dwipa Matra (TDM) (radius maksimal ${ATTENDANCE_TARGET_LOCATION.maxRadiusMeters}m).`
        );
        return;
      }

      // Otomatis matikan kamera jika sedang aktif
      setIsCameraActive(false);

      if (typeof window !== "undefined") {
        setTimeout(() => {
          const resultElem = document.querySelector(".scanner-result-area");
          if (resultElem) {
            resultElem.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }, 50);
      }

      // Trigger radar animation & check-in
      triggerSearchAnimation(member);
    },
    [
      isLocalhost,
      simulationNik,
      simulationBypassDeviceLock,
      simulationBypassGps,
      verifyLocation,
      locationError,
      triggerSearchAnimation,
    ]
  );

  // Reset all attendance data & device session lock (Simulasi / Pengujian)
  const handleResetAllAttendanceAndLock = useCallback(async () => {
    if (
      !confirm(
        "Apakah Anda yakin ingin MENGHAPUS SEMUA DATA ABSENSI dan MERESET KUNCI PERANGKAT ini? Tindakan ini akan mengosongkan seluruh riwayat kehadiran."
      )
    ) {
      return;
    }

    localStorage.removeItem(DEVICE_LOCK_KEY);
    localStorage.removeItem(ATTENDANCE_STORAGE_KEY);
    setDeviceLock(null);
    setRecords({});
    setScannedMember(null);
    setScannedTime(null);
    setTypedNameCount(0);
    setRevealedFieldsCount(0);
    setScanError(null);

    try {
      await fetch("/api/attendance", { method: "DELETE" });
      await fetch("/api/admin/attendance", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer P@ssw0rd#adminEnigma2026",
        },
        body: JSON.stringify({ all: true }),
      }).catch(() => {});
    } catch {
      // ignore
    }
  }, []);

  // Automatic Listener for physical USB / Bluetooth Barcode Scanners
  useEffect(() => {
    let keyBuffer = "";
    let lastKeyTime = Date.now();

    function handleKeyDown(e: KeyboardEvent) {
      // If user is focused on an input or textarea, don't capture
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }

      const now = Date.now();
      // Hardware barcode scanners send keystrokes with < 50ms intervals
      if (now - lastKeyTime > 160) {
        keyBuffer = "";
      }
      lastKeyTime = now;

      if (e.key === "Enter") {
        if (keyBuffer.trim().length >= 4) {
          void handleProcessBarcode(keyBuffer.trim());
        }
        keyBuffer = "";
      } else if (e.key.length === 1) {
        keyBuffer += e.key;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleProcessBarcode]);

  // Typewriter ticker effect directly on Detective ID Card
  useEffect(() => {
    if (!scannedMember) return;

    const targetName = scannedMember.nama;

    if (typedNameCount < targetName.length) {
      typingTimerRef.current = setTimeout(() => {
        setTypedNameCount((prev) => {
          const next = prev + 1;
          playTypingClick();
          return next;
        });
      }, 35);
    } else if (revealedFieldsCount < 6) {
      typingTimerRef.current = setTimeout(() => {
        setRevealedFieldsCount((prev) => prev + 1);
        playTypingClick();
      }, 80);
    }

    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [scannedMember, typedNameCount, revealedFieldsCount]);

  // Fast forward typewriter animation
  const handleSkipTyping = () => {
    if (!scannedMember) return;
    setTypedNameCount(scannedMember.nama.length);
    setRevealedFieldsCount(6);
  };

  // Scroll otomatis ke Kartu Identitas Agen Resmi setelah radar pencarian selesai
  useEffect(() => {
    if (scannedMember && !isSearchingAgent) {
      const timer = setTimeout(() => {
        const cardElem = document.getElementById("official-detective-id-card");
        if (cardElem) {
          cardElem.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [scannedMember, isSearchingAgent]);

  // Camera barcode scanner using html5-qrcode (ZXing engine: Code 128, QR Code, Code 39, EAN 13)
  useEffect(() => {
    if (!isCameraActive) {
      if (html5QrCodeRef.current) {
        const scanner = html5QrCodeRef.current;
        html5QrCodeRef.current = null;
        if (scanner.isScanning) {
          scanner
            .stop()
            .then(() => {
              try {
                scanner.clear();
              } catch {
                // ignore
              }
            })
            .catch(() => {});
        } else {
          try {
            scanner.clear();
          } catch {
            // ignore
          }
        }
      }
      return;
    }

    let active = true;

    async function startScanner() {
      try {
        if (typeof window !== "undefined" && window.location.protocol === "http:" && !isLocalhost) {
          setScanError("Akses kamera membutuhkan protokol HTTPS yang aman. Silakan buka situs melalui tautan https://.");
          setIsCameraActive(false);
          return;
        }

        // Wait a short delay so the container element is rendered with dimensions
        await new Promise((r) => setTimeout(r, 150));
        if (!active) return;

        const readerElem = document.getElementById("attendance-camera-reader");
        if (!readerElem) return;

        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
        if (!active) return;

        if (html5QrCodeRef.current) {
          try {
            if (html5QrCodeRef.current.isScanning) {
              await html5QrCodeRef.current.stop();
            }
            html5QrCodeRef.current.clear();
          } catch {
            // ignore
          }
          html5QrCodeRef.current = null;
        }

        const scanner = new Html5Qrcode("attendance-camera-reader", {
          verbose: false,
          formatsToSupport: [
            Html5QrcodeSupportedFormats.QR_CODE,
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.EAN_13,
          ],
          experimentalFeatures: {
            useBarCodeDetectorIfSupported: true,
          },
        });

        html5QrCodeRef.current = scanner;

        const scanSuccessCallback = (decodedText: string) => {
          if (isProcessingScanRef.current) return;
          isProcessingScanRef.current = true;
          void handleProcessBarcode(decodedText).finally(() => {
            setTimeout(() => {
              isProcessingScanRef.current = false;
            }, 1500);
          });
        };

        const scanConfig = {
          fps: 20,
        };

        try {
          await scanner.start(
            { facingMode: "environment" },
            scanConfig,
            scanSuccessCallback,
            () => {}
          );
        } catch {
          // Fallback to user-facing camera if environment/rear camera is not available
          if (active) {
            await scanner.start(
              { facingMode: "user" },
              scanConfig,
              scanSuccessCallback,
              () => {}
            );
          }
        }

        if (!active) {
          try {
            if (scanner.isScanning) {
              await scanner.stop();
            }
            scanner.clear();
          } catch {
            // ignore
          }
        }
      } catch (err: unknown) {
        if (!active) return;
        const msg = err instanceof Error ? err.message : String(err);
        setScanError(`Gagal membuka kamera: ${msg}. Pastikan izin kamera aktif di browser Anda.`);
        setIsCameraActive(false);
      }
    }

    void startScanner();

    return () => {
      active = false;
      if (html5QrCodeRef.current) {
        const scanner = html5QrCodeRef.current;
        html5QrCodeRef.current = null;
        if (scanner.isScanning) {
          scanner
            .stop()
            .then(() => {
              try {
                scanner.clear();
              } catch {
                // ignore
              }
            })
            .catch(() => {});
        } else {
          try {
            scanner.clear();
          } catch {
            // ignore
          }
        }
      }
    };
  }, [isCameraActive, isLocalhost, handleProcessBarcode]);

  const isNameTypingComplete = Boolean(
    scannedMember && typedNameCount >= scannedMember.nama.length
  );
  const displayedName = scannedMember ? scannedMember.nama.slice(0, typedNameCount) : "";

  return (
    <div className="attendance-page-shell">
      {/* HEADER HERO (CLEAN & BALANCED) */}
      <header className="attendance-header-hero panel">
        <div className="header-meta-row">
          <span className="eyebrow">
            <Icon name="compass" size={15} /> SISTEM ABSENSI AGENT · RAKER 2026
          </span>
          <span className="header-tag-live">
            <span className="live-dot" /> VERIFIKASI LOKASI AKTIF
          </span>
        </div>

        <h1 className="attendance-hero-title">
          Absensi Agent <em>The Sai Bumi Enigma</em>
        </h1>
        <p className="attendance-hero-desc">
          Verifikasi kehadiran detektif resmi melalui pemindaian barcode fisik di lokasi acara PT.
          Tunas Dwipa Matra (TDM).
        </p>
      </header>

      {/* SCANNER & RESULT SECTION */}
      <section className="scanner-section">
        <div className="scanner-layout-grid">
          {/* SCANNER CONTROLLER CARD (BARCODE ONLY) */}
          <div className="scanner-controls-card panel">
            <div className="card-kicker">
              <Icon name="shield" size={14} />
              <span>PEMINDAI BARCODE RESMI</span>
            </div>
            <h2 className="controls-heading">Pindai Barcode Agen</h2>

            {/* LOCATION VERIFICATION BOX */}
            <div
              className={`location-verification-card ${
                locationStatus === "granted"
                  ? "is-verified"
                  : locationStatus === "out_of_range"
                  ? "is-rejected"
                  : locationStatus === "denied"
                  ? "is-warning"
                  : ""
              }`}
            >
              <div className="loc-card-top">
                <span className="loc-icon-pill">
                  <Icon name="compass" size={16} />
                </span>
                <div>
                  <strong>Lokasi Acara: PT. Tunas Dwipa Matra (TDM)</strong>
                  <span className="loc-coords">
                    Lat: {ATTENDANCE_TARGET_LOCATION.latitude.toFixed(5)}, Long:{" "}
                    {ATTENDANCE_TARGET_LOCATION.longitude.toFixed(5)} · Radius Maks:{" "}
                    {ATTENDANCE_TARGET_LOCATION.maxRadiusMeters}m
                  </span>
                </div>
              </div>

              {/* REAL DEVICE GPS DETAIL BOX */}
              <div className="device-gps-info-box">
                <div className="gps-row-header">
                  <span className="gps-label">LOKASI PERANGKAT ANDA:</span>
                  {locationStatus === "checking" ? (
                    <span className="gps-status-pill pill-checking">
                      <span className="spinner small" /> Memeriksa GPS...
                    </span>
                  ) : locationStatus === "granted" ? (
                    <span className="gps-status-pill pill-valid">
                      <Icon name="check" size={12} /> DI AREA ACARA (VALID)
                    </span>
                  ) : locationStatus === "out_of_range" ? (
                    <span className="gps-status-pill pill-invalid">
                      <Icon name="close" size={12} /> DI LUAR AREA ACARA
                    </span>
                  ) : locationStatus === "denied" ? (
                    <span className="gps-status-pill pill-denied">
                      <Icon name="close" size={12} /> IZIN GPS DITOLAK
                    </span>
                  ) : (
                    <span className="gps-status-pill pill-standby">STANDBY</span>
                  )}
                </div>

                {userLocation ? (
                  <div className="gps-metrics-grid">
                    <div className="gps-metric-item">
                      <span className="metric-lbl">Koordinat Perangkat</span>
                      <strong className="metric-val">
                        {userLocation.latitude.toFixed(5)}, {userLocation.longitude.toFixed(5)}
                      </strong>
                    </div>
                    <div className="gps-metric-item">
                      <span className="metric-lbl">Akurasi GPS</span>
                      <strong className="metric-val">±{userLocation.accuracy} meter</strong>
                    </div>
                    <div className="gps-metric-item">
                      <span className="metric-lbl">Jarak ke Lokasi TDM</span>
                      <strong
                        className={`metric-val ${
                          userLocation.isWithinRange ? "text-success" : "text-danger"
                        }`}
                      >
                        {userLocation.distanceMeters.toLocaleString("id-ID")} meter
                      </strong>
                    </div>
                  </div>
                ) : (
                  <p className="gps-pending-text">
                    {locationStatus === "checking"
                      ? "Sedang membaca koordinat GPS perangkat Anda..."
                      : "Koordinat GPS perangkat belum terdeteksi. Silakan klik tombol di bawah untuk memeriksa."}
                  </p>
                )}

                {locationStatus === "out_of_range" && (
                  <div className="loc-strict-alert">
                    <Icon name="info" size={14} />
                    <span>
                      Absensi DITOLAK karena perangkat Anda berjarak{" "}
                      <strong>
                        {userLocation?.distanceMeters.toLocaleString("id-ID")} meter
                      </strong>{" "}
                      dari PT. Tunas Dwipa Matra (radius maksimal {ATTENDANCE_TARGET_LOCATION.maxRadiusMeters}m).
                    </span>
                  </div>
                )}

                {locationStatus === "denied" && locationError && (
                  <div className="loc-strict-alert alert-denied">
                    <Icon name="close" size={14} />
                    <span>{locationError}</span>
                  </div>
                )}

                <div className="loc-action-bar">
                  <button
                    type="button"
                    className="btn-retry-loc"
                    onClick={() => void detectDeviceLocation()}
                    disabled={locationStatus === "checking"}
                  >
                    <Icon name="refresh" size={13} />
                    <span>Deteksi Ulang GPS Perangkat</span>
                  </button>

                  <a
                    href={ATTENDANCE_TARGET_LOCATION.mapUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-open-map"
                  >
                    <span>Buka Peta Lokasi TDM</span>
                    <Icon name="arrow" size={13} />
                  </a>
                </div>
              </div>
            </div>

            {/* CAMERA TOGGLE & PREVIEW */}
            <div className="camera-viewport-wrap">
              <div className={`scanner-camera-frame ${isCameraActive ? "is-active" : "is-hidden"}`}>
                <div
                  id="attendance-camera-reader"
                  className="scanner-camera-container"
                />
                {isCameraActive && <div className="scanner-laser-line" />}
              </div>

              {!isCameraActive && (
                <div className="camera-idle-box">
                  <span className="camera-idle-icon">
                    <Icon name="search" size={40} />
                  </span>
                  <strong>Kamera Pemindai Barcode & QR Code</strong>
                  <p>
                    Arahkan kamera ke barcode fisik atau QR code tanda pengenal peserta untuk absensi resmi.
                  </p>
                </div>
              )}

              <button
                type="button"
                className={`btn-camera-toggle ${
                  isCameraActive ? "btn-camera-stop" : "btn-camera-start"
                }`}
                onClick={() => setIsCameraActive((prev) => !prev)}
              >
                <Icon name="refresh" size={16} />
                <span>
                  {isCameraActive ? "Matikan Kamera Pemindai" : "Buka Kamera Pemindai Barcode / QR Code"}
                </span>
              </button>
            </div>

            {/* ERROR NOTICE */}
            {scanError && (
              <div className="notice error-notice" role="alert" style={{ marginTop: "16px" }}>
                <Icon name="close" size={16} />
                <span>{scanError}</span>
              </div>
            )}

            {/* SIMULATION MODE PANEL (HANYA DITAMPILKAN DI LOCALHOST SETELAH MOUNT) */}
            {isMounted && isLocalhost && (
              <div className="attendance-simulation-box">
                <div className="simulation-header-toggle">
                  <div className="sim-title-wrap">
                    <span className="sim-badge">MODE SIMULASI LOCALHOST</span>
                    <span className="sim-caption">Pengujian Input NIK (Testing Saja)</span>
                  </div>
                  <button
                    type="button"
                    className={`btn-toggle-sim ${isSimulationOpen ? "is-open" : ""}`}
                    onClick={() => setIsSimulationOpen(!isSimulationOpen)}
                    title="Buka / Tutup panel simulasi input NIK"
                  >
                    <Icon name="search" size={14} />
                    <span>{isSimulationOpen ? "Tutup Simulasi" : "Simulasi Input NIK"}</span>
                  </button>
                </div>

                {isSimulationOpen && (
                  <div className="simulation-body-panel">
                    <p className="simulation-intro-text">
                      Panel ini khusus pengujian lokal (localhost). Di server production, panel ini otomatis tersembunyi.
                    </p>

                    <form className="simulation-form" onSubmit={(e) => void handleSimulateNikSubmit(e)}>
                      <div className="sim-input-row">
                        <input
                          type="text"
                          className="quiz-input sim-text-input"
                          placeholder="Ketik NIK peserta (contoh: DMAD18021)..."
                          value={simulationNik}
                          onChange={(e) => setSimulationNik(e.target.value)}
                          autoComplete="off"
                        />
                        <button
                          type="submit"
                          className="button button-gold sim-btn-submit"
                          disabled={!simulationNik.trim()}
                        >
                          <Icon name="check" size={16} />
                          <span>Simulasi Absen</span>
                        </button>
                      </div>

                      {/* Quick selection dropdown from roster */}
                      <div className="sim-select-row">
                        <label className="sim-select-lbl" htmlFor="sim-quick-select">
                          Atau pilih langsung dari peserta resmi:
                        </label>
                        <select
                          id="sim-quick-select"
                          className="quiz-input sim-select-dropdown"
                          value={simulationNik}
                          onChange={(e) => {
                            const val = e.target.value;
                            setSimulationNik(val);
                            if (val) {
                              void handleSimulateNikSubmit(undefined, val);
                            }
                          }}
                        >
                          <option value="">-- Pilih Peserta untuk Simulasi --</option>
                          {ATTENDANCE_ROSTER.map((m) => (
                            <option key={m.nik} value={m.nik}>
                              {m.nama} ({m.nik}) — {m.namaKelompok}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Simulation Options (Bypass GPS & Bypass Device Lock) */}
                      <div className="sim-options-grid">
                        <label className="sim-checkbox-label">
                          <input
                            type="checkbox"
                            checked={simulationBypassGps}
                            onChange={(e) => setSimulationBypassGps(e.target.checked)}
                          />
                          <span>Bypass Lokasi GPS (Khusus Simulasi)</span>
                        </label>

                        <label className="sim-checkbox-label">
                          <input
                            type="checkbox"
                            checked={simulationBypassDeviceLock}
                            onChange={(e) => setSimulationBypassDeviceLock(e.target.checked)}
                          />
                          <span>Bypass Kunci 1 Perangkat (Bisa Coba Peserta Lain)</span>
                        </label>
                      </div>

                      {/* Clear All Attendance & Reset Lock Button */}
                      <div style={{ marginTop: "14px", borderTop: "1px dashed #5a432f", paddingTop: "12px" }}>
                        <button
                          type="button"
                          className="btn-danger-outline"
                          onClick={() => void handleResetAllAttendanceAndLock()}
                          title="Hapus semua data absensi dan reset sesi perangkat ini"
                          style={{ width: "100%", justifyContent: "center", padding: "10px 14px", fontSize: "11px" }}
                        >
                          <Icon name="close" size={14} />
                          <span>Hapus Semua Absensi & Reset Sesi Perangkat Ini</span>
                        </button>
                      </div>
                    </form>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* RESULTS VIEWPORT: SEARCHING RADAR ANIMATION OR TYPEWRITER ID CARD */}
          <div className="scanner-result-area">
            {/* RADAR SEARCHING OVERLAY (KACA PEMBESAR MENCARI AGENT) */}
            {isSearchingAgent && (
              <div className="searching-agent-overlay panel" role="status" aria-live="polite">
                <div className="radar-screen">
                  <div className="radar-sweep" />
                  <div className="sonar-ring r1" />
                  <div className="sonar-ring r2" />
                  <div className="sonar-ring r3" />
                  <div className="magnifying-glass-center">
                    <span className="magnifying-icon">
                      <Icon name="search" size={54} />
                    </span>
                  </div>
                </div>

                <div className="search-text-content">
                  <span className="search-eyebrow">RADAR ENIGMA AKTIF</span>
                  <h3 className="search-phase-heading">{searchPhaseText}</h3>
                  <p className="search-subtext">Memverifikasi berkas identitas detektif resmi...</p>
                  <div className="searching-progress-line">
                    <div className="searching-progress-fill" />
                  </div>
                </div>
              </div>
            )}

            {/* STANDBY STATE (CLEAN USER-FRIENDLY TEXT) */}
            {!isSearchingAgent && !scannedMember && (
              <div className="scanner-standby-panel panel">
                <div className="standby-icon-ring">
                  <Icon name="compass" size={42} />
                </div>
                <h3>Pindai Barcode Identitas Anda</h3>
                <p>
                  Arahkan kamera ke barcode fisik tanda pengenal Anda untuk memverifikasi kehadiran
                  resmi The Sai Bumi Enigma di lokasi acara.
                </p>
                <div className="standby-hints">
                  <div className="hint-pill">
                    <Icon name="check" size={14} /> Pemindaian Barcode Fisik Resmi
                  </div>
                  <div className="hint-pill">
                    <Icon name="check" size={14} /> Lokasi Acara: PT. Tunas Dwipa Matra (TDM)
                  </div>
                  <div className="hint-pill">
                    <Icon name="check" size={14} /> Verifikasi Kartu Detektif Resmi
                  </div>
                </div>
              </div>
            )}

            {/* ACTIVE RESULT: OFFICIAL DETECTIVE ID CARD (INTEGRATED TYPEWRITER, NO BARCODE) */}
            {!isSearchingAgent && scannedMember && (
              <div className="active-result-display" id="official-detective-id-card">
                <div className="detective-id-card panel">
                  {/* CARD TOPBAR */}
                  <div className="id-card-header">
                    <div className="id-card-brand">
                      <span className="brand-badge-mini">
                        <Icon name="compass" size={18} />
                      </span>
                      <div>
                        <strong>THE SAI BUMI ENIGMA</strong>
                        <span className="id-kicker">KARTU IDENTITAS AGEN RESMI · RAKER 2026</span>
                      </div>
                    </div>
                    <div className="id-card-controls-right">
                      <span className="id-card-number">
                        NO. {String(scannedMember.no).padStart(2, "0")} / 35
                      </span>
                      {isLocalhost && isSimulationOpen && (
                        <button
                          type="button"
                          className="btn-sim-reset-card"
                          onClick={() => {
                            setScannedMember(null);
                            setSimulationNik("");
                          }}
                          title="Kembali ke mode input / pilih peserta lain untuk simulasi"
                        >
                          <Icon name="refresh" size={13} />
                          <span>Coba Agen Lain (Simulasi)</span>
                        </button>
                      )}
                      {!isNameTypingComplete && (
                        <button
                          type="button"
                          className="btn-skip-typing-card"
                          onClick={handleSkipTyping}
                          title="Lewati animasi ketik"
                        >
                          Lewati Animasi ⏩
                        </button>
                      )}
                    </div>
                  </div>

                  {/* CARD MAIN BODY */}
                  <div className="id-card-main-body-integrated">
                    {/* LEFT: AGENT AVATAR & BADGES */}
                    <div className="id-card-avatar-box">
                      <div className="agent-avatar-circle">
                        <Icon name="people" size={44} />
                        <span className="avatar-rank-star">
                          {scannedMember.statusRank.toLowerCase().includes("lead") ? "★★" : "★"}
                        </span>
                      </div>
                      <span className="agent-rank-pill">{scannedMember.statusRank}</span>
                      <span className="agent-gender-tag">{scannedMember.genderLabel}</span>
                      <div className="avatar-status-pill">
                        <Icon name="check" size={12} />
                        <span>TERVERIFIKASI</span>
                      </div>
                    </div>

                    {/* RIGHT: TYPEWRITER NAME & DECRYPTED DATA FIELDS */}
                    <div className="id-card-meta-details-integrated">
                      <span className="agent-title-label">NAMA RESMI AGEN</span>
                      <h2 className="agent-name-title-typewriter">
                        {displayedName}
                        {!isNameTypingComplete && (
                          <span className="typewriter-cursor-gold">█</span>
                        )}
                      </h2>

                      <p className="agent-position-subtitle">
                        <span className="pos-badge">{scannedMember.posisi}</span>
                        <span className="dept-sep">•</span>
                        <span className="dept-text">{scannedMember.dept}</span>
                      </p>

                      {/* INFO GRID WITH SEQUENTIAL FADE-IN DECRYPTION */}
                      <div className="agent-info-grid-integrated">
                        <div
                          className={`info-cell ${
                            revealedFieldsCount >= 1 ? "is-revealed" : "is-encrypted"
                          }`}
                        >
                          <span className="info-lbl">NIK DETEKTIF</span>
                          <strong className="info-val text-gold">{scannedMember.nik}</strong>
                        </div>

                        <div
                          className={`info-cell ${
                            revealedFieldsCount >= 2 ? "is-revealed" : "is-encrypted"
                          }`}
                        >
                          <span className="info-lbl">DEPARTEMEN</span>
                          <strong className="info-val">{scannedMember.dept}</strong>
                        </div>

                        <div
                          className={`info-cell ${
                            revealedFieldsCount >= 3 ? "is-revealed" : "is-encrypted"
                          }`}
                        >
                          <span className="info-lbl">KELOMPOK TIM</span>
                          <strong className="info-val text-gold">
                            {scannedMember.namaKelompok} (Tim {scannedMember.groupNumber})
                          </strong>
                        </div>

                        <div
                          className={`info-cell ${
                            revealedFieldsCount >= 4 ? "is-revealed" : "is-encrypted"
                          }`}
                        >
                          <span className="info-lbl">STATUS RANK</span>
                          <strong className="info-val text-gold">
                            {scannedMember.statusRank}
                          </strong>
                        </div>

                        <div
                          className={`info-cell ${
                            revealedFieldsCount >= 5 ? "is-revealed" : "is-encrypted"
                          }`}
                        >
                          <span className="info-lbl">JABATAN</span>
                          <strong className="info-val">{scannedMember.jabatan}</strong>
                        </div>

                        <div
                          className={`info-cell ${
                            revealedFieldsCount >= 6 ? "is-revealed" : "is-encrypted"
                          }`}
                        >
                          <span className="info-lbl">JENIS KELAMIN</span>
                          <strong className="info-val">
                            {scannedMember.genderLabel} ({scannedMember.gender})
                          </strong>
                        </div>
                      </div>

                      {/* ATTENDANCE CONFIRMED STAMP BANNER */}
                      <div className="id-card-attendance-stamp">
                        <div className="stamp-left">
                          <Icon name="award" size={22} />
                          <div>
                            <strong>STATUS KEHADIRAN: TERABSENSI RESMI</strong>
                            <span>
                              Waktu Scan:{" "}
                              {scannedTime
                                ? new Date(scannedTime).toLocaleString("id-ID", {
                                    dateStyle: "full",
                                    timeStyle: "medium",
                                    timeZone: "Asia/Jakarta",
                                  })
                                : "-"}{" "}
                              WIB
                            </span>
                            <span className="stamp-sub-loc">
                              Lokasi: PT. Tunas Dwipa Matra (TDM)
                            </span>
                          </div>
                        </div>
                        <div className="stamp-seal">CHECK-IN VALID</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
