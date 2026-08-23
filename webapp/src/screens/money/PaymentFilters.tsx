/**
 * Search plus allocation state. Deliberately not the gig list's filter
 * set — no client, no date range: the payment list is short, and search
 * already covers the client case (see the design's "Filters" section).
 */
import { Button, Input, Select } from "../../components/index.ts";
import {
  DEFAULT_PAYMENT_FILTERS,
  isPaymentFiltered,
  type PaymentFilters as Filters,
} from "../../lib/payment-filters.ts";

export function PaymentFilters({
  filters,
  onChange,
  shown,
  total,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  shown: number;
  total: number;
}) {
  const filtered = isPaymentFiltered(filters);
  return (
    <div className="space-y-2" data-testid="payment-filters">
      <Input
        type="search"
        aria-label="Search payments"
        data-testid="payment-search"
        placeholder="Client, note or amount"
        value={filters.search}
        onChange={(e) => onChange({ ...filters, search: e.target.value })}
      />
      <div className="flex items-center gap-2">
        <Select
          aria-label="Allocation state"
          data-testid="payment-state"
          value={filters.state}
          onChange={(e) =>
            onChange({ ...filters, state: e.target.value as Filters["state"] })
          }
        >
          <option value="all">All payments</option>
          <option value="unallocated">Not yet allocated</option>
          <option value="partly">Partly allocated</option>
          <option value="fully">Fully allocated</option>
        </Select>
        {filtered && (
          <Button
            variant="ghost"
            data-testid="payment-clear"
            onClick={() => onChange(DEFAULT_PAYMENT_FILTERS)}
          >
            Clear
          </Button>
        )}
      </div>
      {filtered && (
        <p className="text-xs text-slate-500" data-testid="payment-count">
          Showing {shown} of {total}
        </p>
      )}
    </div>
  );
}
