import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { DataState, Pagination, StatusBadge, describeError } from './ui';

describe('DataState', () => {
  it('shows loading, error with retry, empty and content states explicitly', async () => {
    const reload = vi.fn();
    const { rerender } = render(
      <DataState data={undefined} loading error={undefined}>
        {() => <div>content</div>}
      </DataState>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading');

    rerender(
      <DataState
        data={undefined}
        loading={false}
        error={
          new ApiError(
            503,
            { code: 'DATABASE_UNAVAILABLE', message: 'try again', status: 503, correlationId: 'abc' },
            'try again',
          )
        }
        reload={reload}
      >
        {() => <div>content</div>}
      </DataState>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('try again');
    expect(screen.getByRole('alert')).toHaveTextContent('reference abc');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalled();

    rerender(
      <DataState data={[]} loading={false} error={undefined} isEmpty={(d) => d.length === 0} empty="Nothing here">
        {() => <div>content</div>}
      </DataState>,
    );
    expect(screen.getByText('Nothing here')).toBeInTheDocument();

    rerender(
      <DataState data={[1]} loading={false} error={undefined} isEmpty={(d) => d.length === 0}>
        {(d) => <div>{d.length} item</div>}
      </DataState>,
    );
    expect(screen.getByText('1 item')).toBeInTheDocument();
  });

  it('keeps stale data visible when a refresh fails', () => {
    render(
      <DataState data={['x']} loading={false} error={new Error('refresh failed')}>
        {(d) => <div>{d[0]}</div>}
      </DataState>,
    );
    expect(screen.getByText('x')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('refresh failed');
  });
});

describe('describeError', () => {
  it('explains network failures without status codes', () => {
    expect(describeError(new ApiError(0, null, 'Cannot reach the PaySense API.'))).toBe('Cannot reach the PaySense API.');
  });
});

describe('Pagination', () => {
  it('disables previous on the first page and next on the last', async () => {
    const onPage = vi.fn();
    const { rerender } = render(<Pagination page={0} totalPages={3} onPage={onPage} />);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPage).toHaveBeenCalledWith(1);
    rerender(<Pagination page={2} totalPages={3} onPage={onPage} />);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
  it('renders nothing for a single page', () => {
    const { container } = render(<Pagination page={0} totalPages={1} onPage={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('StatusBadge', () => {
  it('renders the status text', () => {
    render(
      <MemoryRouter>
        <StatusBadge status="UNCERTAIN" />
      </MemoryRouter>,
    );
    expect(screen.getByText('UNCERTAIN')).toHaveClass('unc');
  });
});
