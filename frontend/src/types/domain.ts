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
  createdAt: string;
  updatedAt: string;
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
