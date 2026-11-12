export type UserRole =
  | 'CUSTOMER'
  | 'MERCHANT_ADMIN'
  | 'MERCHANT_STAFF'
  | 'DELIVERY_PARTNER'
  | 'COLLECTION_CENTRE'
  | 'ADMIN';

export type OwnershipModel = 'SHARED_POOL' | 'MERCHANT_OWNED' | 'HYBRID';
export type PackageOwnerType = 'REBOXIFY_POOL' | 'MERCHANT' | 'HYBRID';
export type PackageClass = 'S' | 'M' | 'L' | 'XL';

export interface PublicUser {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  status: 'ACTIVE' | 'SUSPENDED' | 'INVITED';
  businessId?: string;
  collectionCenterId?: string;
}

export interface AuthSession {
  isAuthenticated: boolean;
  token: string | null;
  user: PublicUser | null;
}

export interface HealthResponse {
  status: string;
  service: string;
  environment: string;
  currency: string;
  uptimeSeconds: number;
  timestamp: string;
  database: {
    connected: boolean;
    replicaSetSupported: boolean;
    statusMessage?: string;
  };
  worker?: {
    status: string;
    lastHeartbeatAt?: string;
    lastCycleAt?: string;
    lastCycleStatus?: string;
    consecutiveFailures?: number;
  };
  integrations: {
    paypalSandboxConfigured: boolean;
    paypalWebhookConfigured: boolean;
    geminiConfigured: boolean;
    elasticsearchConfigured: boolean;
    pickupSchedulerConfigured?: boolean;
    bryntumSchedulerMode: string;
    statuses?: {
      mongodb: string;
      replicaSet: string;
      worker: string;
      paypal: string;
      paypalWebhook: string;
      elasticsearch: string;
      gemini: string;
      pickupScheduler: string;
    };
    diagnostics?: {
      elasticsearch?: { status: string; clusterName?: string; message?: string; checkedAt: string };
      gemini?: { status: string; model?: string; message?: string; checkedAt: string };
    };
  };
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface BusinessDto {
  id: string;
  ownerUserId: string;
  name: string;
  legalName: string;
  slug: string;
  currency: string;
  packagingModel: OwnershipModel;
  allowCrossMerchantPool: boolean;
  policies: {
    returnWindowDays: number;
    autoApproveOnPass: boolean;
    depositMultiplier: number;
    allowedReturnApprovers: string[];
  };
  status: 'ACTIVE' | 'ONBOARDING' | 'SUSPENDED';
  createdAt: string;
}

export interface ProductDto {
  id: string;
  merchantId: string;
  sku: string;
  name: string;
  dimensionsCm: { length: number; width: number; height: number };
  weightKg: number;
  allowedOrientations: string[];
  rotatable: boolean;
  fragility: 'LOW' | 'MEDIUM' | 'HIGH';
  restrictions: {
    liquidContainment: boolean;
    temperatureControlled: boolean;
    contaminationSensitive: boolean;
    notes?: string;
  };
  unitPrice: number;
  currency: string;
  active: boolean;
}

export interface PackageDto {
  id: string;
  packageId: string;
  ownerType: PackageOwnerType;
  ownerId?: string;
  packageClass: PackageClass;
  dimensionsCm: { length: number; width: number; height: number };
  maxWeightKg: number;
  protectionCategory: 'STANDARD' | 'REINFORCED' | 'HIGH_PROTECTION';
  supportsLiquidContainment: boolean;
  replacementValue: number;
  depositAmount: number;
  currency: string;
  status: string;
  condition: string;
  reuseCount: number;
  maxLifecycleLimit: number;
  fulfilmentLocation: string;
  currentCustodian: {
    custodianType: string;
    custodianId: string;
    label: string;
    assignedAt: string;
  };
  currentOrderId?: string;
  qrTokenVersion?: number;
  qrRevoked?: boolean;
  qrRevokedAt?: string;
  assignedPartnerUserId?: string;
  assignedPartnerName?: string;
  lastInspectionAt?: string;
  lastInspectionOutcome?: 'PASS' | 'FAIL' | 'NEEDS_REVIEW';
  lastCleanedAt?: string;
}

export interface PackageCatalogueSpec {
  packageClass: PackageClass;
  dimensionsCm: { length: number; width: number; height: number };
  maxWeightKg: number;
  protectionCategory: string;
  supportsLiquidContainment: boolean;
  replacementValue: number;
  baseDeposit: number;
  usageFee: number;
  currency: string;
}

export interface OrderDto {
  id: string;
  orderNumber: string;
  merchantId: string;
  customerId: string;
  items: Array<{
    productId: string;
    sku: string;
    name: string;
    quantity: number;
    unitPrice: number;
  }>;
  shippingReference: {
    recipientName: string;
    zone: string;
    addressLine: string;
    fulfilmentLocation: string;
  };
  allocatedPackages: Array<{
    packageRef: string;
    packageId: string;
    packageClass: string;
    ownerType: string;
    depositAmount: number;
    depositBreakdown?: {
      baseDeposit: number;
      multiplier: number;
      replacementValue: number;
      ruleVersion: string;
    };
    explanation?: string;
  }>;
  allocationMetadata?: {
    outcome: string;
    policyVersion: string;
    allocatedAt?: string;
    splitRecommended?: boolean;
    notes?: string;
  };
  totals: {
    productSubtotal: number;
    depositTotal: number;
    shippingTotal: number;
    taxTotal: number;
    grandTotal: number;
  };
  currency: string;
  status: string;
  returnDeadlineAt?: string;
  createdAt: string;
}

export interface PayPalPublicConfig {
  paypalConfigured: boolean;
  paypalClientId: string | null;
  currency: string;
  environment: 'sandbox' | 'live';
}

export interface TransactionDto {
  id: string;
  orderId: string;
  orderNumber?: string;
  merchantId: string;
  customerId: string;
  paypalOrderId: string;
  captureId?: string;
  amount: number;
  currency: string;
  state: string;
  depositAllocations: Array<{
    packageId: string;
    allocatedDeposit: number;
    refundedAmount: number;
    pendingRefundAmount: number;
  }>;
  refundSummary?: {
    refundedTotal: number;
    pendingTotal: number;
    latestRefundState?: string;
    refundCount: number;
  };
  capturedAt?: string;
  providerStatus?: string;
  createdAt: string;
  updatedAt: string;
}

export type ScanAction =
  | 'PACK'
  | 'DISPATCH'
  | 'DELIVER'
  | 'COLLECT_RETURN'
  | 'RECEIVE_CENTRE'
  | 'INSPECT_PASS'
  | 'QUARANTINE'
  | 'MARK_CLEANING'
  | 'RELEASE_AVAILABLE';

export interface QrLabelData {
  packageId: string;
  packageClass: PackageClass;
  dimensionsCm: { length: number; width: number; height: number };
  maxWeightKg: number;
  protectionCategory: 'STANDARD' | 'REINFORCED' | 'HIGH_PROTECTION';
  supportsLiquidContainment: boolean;
  material: string;
  ownerType: PackageOwnerType;
  fulfilmentLocation: string;
  tokenVersion: number;
  qrToken: string;
  issuedAt: string;
  expiresAt: string;
  handlingInstructions: string[];
}

export interface PassportEventSummary {
  eventId: string;
  type: string;
  actorRole: string;
  occurredAt: string;
  outcome: 'ACCEPTED' | 'REJECTED';
  locationRef?: string;
  summary: string;
}

export interface DigitalPassportView {
  packageId: string;
  packageClass: PackageClass;
  dimensionsCm: { length: number; width: number; height: number };
  maxWeightKg: number;
  protectionCategory: 'STANDARD' | 'REINFORCED' | 'HIGH_PROTECTION';
  supportsLiquidContainment: boolean;
  material: string;
  ownership: {
    ownerType: PackageOwnerType;
    ownerId?: string;
    ownerLabel: string;
  };
  status: string;
  condition: string;
  reuseCount: number;
  maxLifecycleLimit: number;
  fulfilmentLocation: string;
  currentCustodian: {
    custodianType: string;
    custodianId?: string;
    label: string;
    assignedAt: string;
  };
  activeOrder?: {
    orderId: string;
    orderNumber: string;
    status: string;
    paymentCaptured: boolean;
  };
  assignedPartner?: {
    userId: string;
    name: string;
  };
  qrSecurity: {
    tokenVersion: number;
    revoked: boolean;
    revokedAt?: string;
  };
  cleaningAndInspection: {
    lastInspectionAt?: string;
    lastInspectionOutcome?: 'PASS' | 'FAIL' | 'NEEDS_REVIEW';
    lastCleanedAt?: string;
  };
  sustainability: {
    verified: boolean;
    verifiedReuseCycles: number;
    remainingLifecycleCycles: number;
    singleUsePackagingAvoided: number;
    verificationNote: string;
  };
  lifecycleHistory: PassportEventSummary[];
}

export interface DeliveryPartnerSummary {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: string;
}

export type ReturnMode = 'PICKUP' | 'DROP_OFF' | 'NEXT_DELIVERY_SWAP';

export type InspectionCondition =
  | 'GOOD'
  | 'MINOR_WEAR'
  | 'MINOR_DAMAGE'
  | 'MAJOR_DAMAGE'
  | 'CONTAMINATED'
  | 'MISSING_PACKAGING'
  | 'UNUSABLE'
  | 'WRONG_PACKAGE';

export interface DeductionItemDto {
  code: string;
  label: string;
  amount: number;
  reason: string;
}

export interface ReturnDto {
  id: string;
  returnNumber: string;
  orderId: string;
  orderNumber?: string;
  packageRef: string;
  packageId: string;
  merchantId: string;
  customerId: string;
  mode: ReturnMode;
  returnMethodDetails?: {
    dropoffLocationLabel?: string;
    pickupWindowStart?: string;
    pickupWindowEnd?: string;
    serviceZone?: string;
    addressSummary?: string;
    swapOrderNumber?: string;
  };
  assignedPartnerUserId?: string;
  assignedPartnerName?: string;
  status: string;
  reason?: string;
  returnDeadlineAt?: string;
  isLateReturn: boolean;
  daysLate: number;
  disputed: boolean;
  disputeReason?: string;
  collectedAt?: string;
  receivedAt?: string;
  evidenceFiles: Array<{
    fileId: string;
    filename: string;
    mimeType: string;
    sizeBytes?: number;
    uploadedAt: string;
    uploadedBy: string;
  }>;
  inspection?: {
    inspectorId: string;
    inspectedAt: string;
    checklist: {
      identityVerified: boolean;
      structuralIntegrity: boolean;
      cleanlinessAcceptable: boolean;
      completeComponents: boolean;
    };
    condition: InspectionCondition;
    outcome: 'PASS' | 'FAIL' | 'NEEDS_REVIEW';
    damageReason?: string;
    notes?: string;
  };
  decision?: {
    decidedBy: string;
    decidedAt: string;
    outcome: 'APPROVED' | 'REJECTED' | 'NEEDS_REVIEW';
    reason: string;
  };
  refundEligibility: {
    eligible: boolean;
    reason?: string;
    originalDeposit: number;
    totalDeductions: number;
    calculatedAmount: number;
    currency: string;
    ruleVersion?: string;
    deductionBreakdown: DeductionItemDto[];
  };
  refundId?: string;
  refundSummary?: {
    refundId: string;
    state: string;
    amount: number;
    providerRefundId?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export type PickupStatus =
  | 'UNASSIGNED'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'MISSED'
  | 'RESCHEDULED'
  | 'CANCELLED';

export interface PickupRescheduleEntryDto {
  previousStart: string;
  previousEnd: string;
  newStart: string;
  newEnd: string;
  reason: string;
  changedBy: string;
  changedAt: string;
}

export interface PickupDto {
  id: string;
  returnId: string;
  returnNumber?: string;
  orderId?: string;
  orderNumber?: string;
  packageId: string;
  merchantId: string;
  customerId?: string;
  collectionCenterId?: string;
  slotStart: string;
  slotEnd: string;
  timeZone: string;
  pickupMethod: ReturnMode;
  serviceZone: string;
  addressSummary: string;
  location?: { lat: number; lng: number };
  partnerId?: string;
  assignedPartnerName?: string;
  status: PickupStatus;
  rescheduleHistory: PickupRescheduleEntryDto[];
  missedReason?: string;
  cancelReason?: string;
  notes?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PartnerScheduleDto {
  id?: string;
  userId: string;
  displayName: string;
  email?: string;
  serviceZones: string[];
  timeZone: string;
  workingHours: {
    startHour: number;
    endHour: number;
    daysOfWeek: number[];
  };
  unavailablePeriods: Array<{
    start: string;
    end: string;
    reason?: string;
  }>;
  dailyCapacity: number;
  maxConcurrentCapacity: number;
  bookingLockVersion: number;
  status: 'ACTIVE' | 'UNAVAILABLE' | 'SUSPENDED';
}

export interface CollectionCentreDto {
  id: string;
  code: string;
  name: string;
  operatorUserId: string;
  address: string;
  serviceZones: string[];
  hours: string;
  capacity: number;
  currentWorkload: number;
  status: 'ACTIVE' | 'FULL' | 'OFFLINE';
}

export interface PartnerAvailabilitySlot {
  slotStart: string;
  slotEnd: string;
  availablePartners: number;
  serviceZone?: string;
}

export interface PickupResourcesResponse {
  roleScope: string;
  partners: PartnerScheduleDto[];
  collectionCentres: CollectionCentreDto[];
  availableSlots?: PartnerAvailabilitySlot[];
}

export interface RefundDto {
  id: string;
  transactionId: string;
  orderId: string;
  returnId: string;
  merchantId: string;
  packageId: string;
  captureId: string;
  paypalRequestId: string;
  providerRefundId?: string;
  providerStatus?: string;
  failureReason?: string;
  amount: number;
  currency: string;
  reason: string;
  state: string;
  idempotencyKey: string;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchPaginatedResponse<T> extends PaginatedResponse<T> {
  searchEngine: 'ELASTICSEARCH' | 'MONGODB_FALLBACK';
  degradedReason?: string;
}

export interface SearchStatusSnapshot {
  elasticsearch: {
    configured: boolean;
    status: 'NOT_CONFIGURED' | 'CONNECTED' | 'DEGRADED';
    clusterName?: string;
    version?: string;
    message?: string;
    checkedAt: string;
  };
  outbox: {
    pending: number;
    processing: number;
    failed: number;
    completed: number;
  };
  indices: Record<string, number | null>;
  latestReindexJob?: {
    jobId: string;
    status: string;
    currentEntity?: string;
    processedCounts: Record<string, number>;
    failedCount: number;
    lastError?: string;
    startedAt: string;
    finishedAt?: string;
  };
}

export interface OperationalMetricsSnapshot {
  scope: 'NETWORK' | 'MERCHANT';
  merchantId?: string;
  generatedAt: string;
  packages: {
    total: number;
    availableForReuse: number;
    cleaningCount: number;
    repairOrQuarantineCount: number;
    withCustomerOrReturnCount: number;
    totalReuseCycles: number;
    averageReuseCycles: number;
    statusBreakdown: Record<string, number>;
    availableByClass: Record<string, number>;
  };
  returns: {
    total: number;
    pendingInspectionCount: number;
    approvedCount: number;
    rejectedCount: number;
    lateReturnCount: number;
    disputedCount: number;
    conditionBreakdown: Record<string, number>;
  };
  pickups: {
    total: number;
    unassignedCount: number;
    missedCount: number;
    completedCount: number;
    partnerWorkload: Array<{ partnerName: string; activeCount: number }>;
  };
  orders: {
    total: number;
    deliveredCount: number;
    paidCount: number;
    placedCount: number;
  };
}

export interface OperationalInsightsResponse {
  aiStatus: 'GENERATED' | 'DISABLED';
  aiGenerated: boolean;
  modelName: string;
  answer: string | null;
  caveats: string[];
  recommendations: string[];
  measuredFacts: OperationalMetricsSnapshot;
  disclaimer: string;
}

export interface InspectionAssistResponse {
  aiStatus: 'GENERATED' | 'DISABLED';
  aiGenerated: boolean;
  modelName: string;
  returnId: string;
  returnNumber: string;
  packageId: string;
  inspectionSummary: string | null;
  suggestedCondition: InspectionCondition | null;
  damageCategoriesExplanation: string[];
  suggestedNextSteps: string[];
  refundControlLocked: true;
  advisoryNotice: string;
}
