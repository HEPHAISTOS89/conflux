import type { Icon as PhIcon, IconWeight } from '@phosphor-icons/react';
import {
  ArrowCounterClockwiseIcon as ArrowCounterClockwise, ArrowRightIcon as ArrowRight, ArrowSquareOutIcon as ArrowSquareOut, ArrowsOutSimpleIcon as ArrowsOutSimple, BicycleIcon as Bicycle, BroadcastIcon as Broadcast, CalendarCheckIcon as CalendarCheck, CarIcon as Car, CaretDownIcon as CaretDown, CaretUpDownIcon as CaretUpDown, ChartLineUpIcon as ChartLineUp, ChatTeardropTextIcon as ChatTeardropText, CheckIcon as Check, CheckCircleIcon as CheckCircle, CircleNotchIcon as CircleNotch, ClockIcon as Clock, CloudArrowUpIcon as CloudArrowUp, CopyIcon as Copy, CpuIcon as Cpu, CrosshairIcon as Crosshair, CubeIcon as Cube, DatabaseIcon as Database, DownloadSimpleIcon as DownloadSimple, EyeIcon as Eye, EyeSlashIcon as EyeSlash, FileTextIcon as FileText, FunnelIcon as Funnel, GaugeIcon as Gauge, HardDrivesIcon as HardDrives, InfoIcon as Info, IntersectionIcon as Intersection, KeyboardIcon as Keyboard, LightningIcon as Lightning, LinkSimpleIcon as LinkSimple, ListIcon as List, MagnifyingGlassIcon as MagnifyingGlass, MapTrifoldIcon as MapTrifold, MathOperationsIcon as MathOperations, MoonIcon as Moon, PathIcon as Path, PauseIcon as Pause, PaperPlaneRightIcon as PaperPlaneRight, PersonSimpleWalkIcon as PersonSimpleWalk, PlayIcon as Play, PulseIcon as Pulse, RankingIcon as Ranking, RoadHorizonIcon as RoadHorizon, ScanIcon as Scan, ShieldCheckIcon as ShieldCheck, SignpostIcon as Signpost, StackIcon as Stack, SunIcon as Sun, TargetIcon as Target, TrafficSignalIcon as TrafficSignal, TreeStructureIcon as TreeStructure, TruckIcon as Truck, VideoCameraIcon as VideoCamera, WarningIcon as Warning, XIcon as X, XCircleIcon as XCircle, WifiSlashIcon as WifiSlash, MapPinAreaIcon as MapPinArea, ArrowsInIcon as ArrowsIn, ArrowsOutIcon as ArrowsOut, CompassIcon as Compass, ImageIcon as ImageI, QuestionIcon as Question, CaretRightIcon as CaretRight, CaretLeftIcon as CaretLeft, SkipForwardIcon as SkipForward, SkipBackIcon as SkipBack, FlagIcon as Flag, CircleIcon as Circle, SidebarSimpleIcon as SidebarSimple,
} from '@phosphor-icons/react';

/** One icon family (Phosphor) on one optical grid; names describe the job, not the drawing. */
const ICONS = {
  atlas: MapTrifold, rank: Ranking, corridor: RoadHorizon, ped: PersonSimpleWalk, bike: Bicycle, lidar: Broadcast,
  methods: MathOperations, sheet: FileText, platform: TreeStructure, ask: ChatTeardropText, menu: List, sun: Sun, moon: Moon,
  close: X, play: Play, pause: Pause, arrow: ArrowRight, external: ArrowSquareOut, download: DownloadSimple, link: LinkSimple,
  search: MagnifyingGlass, filter: Funnel, layers: Stack, camera: VideoCamera, crosshair: Crosshair, car: Car, truck: Truck,
  warning: Warning, info: Info, check: Check, ok: CheckCircle, fail: XCircle, spinner: CircleNotch, keyboard: Keyboard,
  caret: CaretDown, caretUpDown: CaretUpDown, fit: ArrowsOutSimple, reset: ArrowCounterClockwise, clock: Clock, db: Database,
  lambda: Lightning, ec2: HardDrives, schedule: CalendarCheck, pulse: Pulse, iam: ShieldCheck, bedrock: Cpu, edge: Cube,
  upload: CloudArrowUp, copy: Copy, gauge: Gauge, trend: ChartLineUp, target: Target, signal: TrafficSignal, scan: Scan,
  path: Path, sign: Signpost, intersection: Intersection, eye: Eye, eyeOff: EyeSlash, send: PaperPlaneRight,
  offline: WifiSlash, county: MapPinArea, sensor: Broadcast, pedestrian: PersonSimpleWalk, vehicle: Car, alert: Warning,
  fullscreen: ArrowsOut, exitFullscreen: ArrowsIn, compass: Compass, image: ImageI, help: Question, next: CaretRight, prev: CaretLeft,
  stepFwd: SkipForward, stepBack: SkipBack, flag: Flag, dot: Circle, sidebar: SidebarSimple,
} satisfies Record<string, PhIcon>;

export type IconName = keyof typeof ICONS;

/** Spec icon grid (docs/DESIGN_SPEC.md): 14 inline, 16 buttons/nav, 20 panel headers, 24 page badges. Glyph dots (< 12) keep their size. */
export function iconSize(size: number): number {
  if (size < 12) return size;
  if (size <= 15) return 14;
  if (size <= 18) return 16;
  if (size <= 22) return 20;
  return 24;
}

export function Icon({ name, size = 16, title, weight = 'regular' }: { name: IconName; size?: number; title?: string; weight?: IconWeight }) {
  const C = ICONS[name];
  return (
    <C
      className="icon"
      size={iconSize(size)}
      weight={weight}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
    />
  );
}
