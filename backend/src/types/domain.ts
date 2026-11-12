export const USER_ROLES = [
  'CUSTOMER',
  'MERCHANT_ADMIN',
  'MERCHANT_STAFF',
  'DELIVERY_PARTNER',
  'COLLECTION_CENTRE',
  'ADMIN',
] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const OWNERSHIP_MODELS = ['SHARED_POOL', 'MERCHANT_OWNED', 'HYBRID'] as const;
export type OwnershipModel = (typeof OWNERSHIP_MODELS)[number];

export const PACKAGE_OWNER_TYPES = ['REBOXIFY_POOL', 'MERCHANT', 'HYBRID'] as const;
export type PackageOwnerType = (typeof PACKAGE_OWNER_TYPES)[number];

export const PACKAGE_CLASSES = ['S', 'M', 'L', 'XL'] as const;
export type PackageClass = (typeof PACKAGE_CLASSES)[number];

export const PACKAGE_STATUSES = [
  'AVAILABLE',
  'RESERVED',
  'PACKED',
  'DISPATCHED',
  'WITH_CUSTOMER',
  'RETURN_REQUESTED',
  'COLLECTED',
  'AT_CENTRE',
  'INSPECTED',
  'QUARANTINED',
  'CLEANING',
  'REPAIR',
  'UNDER_INVESTIGATION',
  'RETIRED',
] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];

export const ORDER_STATUSES = [
  'PLACED',
  'PAYMENT_PENDING',
  'PAID',
  'ALLOCATED',
  'DISPATCHED',
  'DELIVERED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const RETURN_MODES = ['PICKUP', 'DROP_OFF', 'NEXT_DELIVERY_SWAP'] as const;
export type ReturnMode = (typeof RETURN_MODES)[number];

export const INSPECTION_CONDITIONS = [
  'GOOD',
  'MINOR_WEAR',
  'MINOR_DAMAGE',
  'MAJOR_DAMAGE',
  'CONTAMINATED',
  'MISSING_PACKAGING',
  'UNUSABLE',
  'WRONG_PACKAGE',
] as const;
export type InspectionCondition = (typeof INSPECTION_CONDITIONS)[number];

export const RETURN_STATUSES = [
  'REQUESTED',
  'PICKUP_SCHEDULED',
  'DROP_OFF_SELECTED',
  'COLLECTED',
  'RECEIVED',
  'UNDER_INSPECTION',
  'APPROVED',
  'REJECTED',
  'NEEDS_REVIEW',
  'CLOSED',
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const PAYMENT_STATUSES = [
  'CREATED',
  'APPROVED',
  'CAPTURE_PENDING',
  'CAPTURED',
  'REFUND_REQUESTED',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'CAPTURE_FAILED',
  'REFUND_FAILED',
  'REVERSED',
  'DISPUTED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PICKUP_STATUSES = [
  'UNASSIGNED',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'MISSED',
  'RESCHEDULED',
  'CANCELLED',
] as const;
export type PickupStatus = (typeof PICKUP_STATUSES)[number];

export interface AuthPrincipal {
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  businessId?: string;
  collectionCenterId?: string;
}

