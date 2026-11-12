import React from 'react';
import { DeliveryPartnerSummary, ReturnDto } from '../types/domain';
import { ReturnsGrid } from './grids/ReturnsGrid';

interface ReturnsManagementSectionProps {
  title: string;
  merchantId?: string;
  returnsList?: ReturnDto[];
  partners?: DeliveryPartnerSummary[];
  canApprove?: boolean;
  refreshKey?: number;
  onUpdated: () => Promise<void> | void;
}

export const ReturnsManagementSection: React.FC<ReturnsManagementSectionProps> = ({
  title,
  merchantId,
  partners = [],
  canApprove = true,
  refreshKey = 0,
  onUpdated,
}) => {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-bold tracking-tight">{title}</h3>
      </div>

      <ReturnsGrid
        merchantId={merchantId}
        partners={partners}
        canApprove={canApprove}
        refreshKey={refreshKey}
        onUpdated={onUpdated}
      />
    </div>
  );
};
