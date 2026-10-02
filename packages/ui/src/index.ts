export { Alert } from './components/primitives';
export { InlineFormError } from './components/composites';
export { Button, buttonVariants } from './components/primitives';
export { IconButton } from './components/composites';
export { Input, type InputProps } from './components/primitives';
export { Logo } from './components/composites';
export { Img } from './components/composites';
export { CrawlerEye } from './components/composites';
export {
  Textarea,
  TEXTAREA_MIRROR_CLASSES,
  TEXTAREA_TYPE_SCALE_CLASSES,
  TEXTAREA_WRAP_CLASSES,
} from './components/primitives';
export { CharacterCountTextarea } from './components/composites';
export { AnimatedHeight } from './components/composites';
export { Card, CardHeader, CardTitle, CardDescription, CardContent } from './components/primitives';
export { Separator } from './components/primitives';
export { Badge } from './components/primitives';
export { Tooltip, TooltipTrigger, TooltipContent } from './components/primitives';
export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './components/primitives';
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from './components/primitives';
export {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/primitives';
export { Tabs, TabsList, TabsTrigger, TabsContent } from './components/primitives';
export { ScrollArea } from './components/primitives';
/**
 * `ScrollArea` mounts both bars itself, so nothing outside this package needs
 * `ScrollBar`; it stays published by founder ruling in the 2026-07-30 audit.
 * @keptByRuling
 */
export { ScrollBar } from './components/primitives';
export { Toaster } from './components/primitives';
export { toast } from 'sonner';
export { Label } from './components/primitives';
export { Checkbox } from './components/primitives';
export { Switch } from './components/primitives';
export { ToggleGroup, ToggleGroupItem } from './components/primitives';
export { Overlay } from './components/overlay';
export { OverlayContent, type OverlayContentProps } from './components/overlay';
export { OverlayHeader } from './components/overlay';
export { OverlayDialog } from './components/overlay/overlay-dialog';
export { OverlayBottomSheet } from './components/overlay/overlay-bottom-sheet';
export { Sheet, SheetContent, SheetTitle } from './components/primitives/sheet';
export { ModalActions, type ModalActionButton } from './components/composites';
export { ThemeToggle } from './components/composites';
export { SidebarPanel, useSidebarDrawer } from './components/composites';
export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor } from './components/primitives';
export { PortalContainerProvider } from './components/primitives/portal-container';
export { CodeBlock } from './components/composites';
export { Skeleton } from './components/primitives';
export { EmptyState } from './components/composites';
export { PromptCard } from './components/composites';
export { DenseTable } from './components/composites';
export { ScrollRegion } from './components/composites';
export { PanelFrame } from './components/composites';
export { StatTile } from './components/composites';
export { Meter, type MeterLevel } from './components/composites';
export { ListDetailLayout } from './components/composites';
export { ErrorBoundary, ErrorFallback } from './components/composites';
export { CopyableId } from './components/composites';
export { Kbd, formatHotkey } from './components/composites';
export { SkipLink } from './components/composites';
export { ReleaseStageBadge } from './components/composites/release-stage-badge';
export {
  CommandPalette,
  buildSections,
  type PaletteItem,
  type PaletteSection,
} from './components/composites';

export { CipherWall } from './components/cipher-wall';
export { readThemeColors } from './components/cipher-wall';
export type { ThemeColors } from './components/cipher-wall';

export { FeeBreakdown } from './components/marketing/fee-breakdown';
export { CostPieChart } from './components/marketing/cost-pie-chart';
export { CostBreakdown } from './components/marketing/cost-breakdown';

export {
  ChartContainer,
  ChartTooltipContent,
  ChartLegendContent,
  RechartsChart,
  type ChartConfig,
  type RechartsChartState,
} from './components/primitives';

export { useVisualViewportHeight } from './hooks/use-visual-viewport-height';
export { useIsMobile } from './hooks/use-is-mobile';
/**
 * Two ESLint rules in `packages/config/eslint.config.js` ban
 * `requestAnimationFrame` and name this hook as the import to use instead;
 * withholding it would make the prescribed remedy un-importable.
 * @toolContract
 */
export { useAnimationFrame } from './hooks/use-animation-frame';
export {
  useAsyncAction,
  UserMessageError,
  type UseAsyncActionReturn,
} from './hooks/use-async-action';
export { useHotkeys, type Hotkey, type HotkeyBinding } from './hooks/use-hotkeys';
export { useCopyToClipboard } from './hooks/use-copy-to-clipboard';
export { useReducedMotion, shouldReduceMotion } from './hooks/use-reduced-motion';
export { TouchDeviceOverrideContext } from './hooks/touch-device-override-context';

export { cn } from './lib/utilities';
export { triggerViewTransition } from './lib/trigger-view-transition';
