import type { Metadata } from 'next';

import { AdminScreen } from '@/components/admin-screen';

/**
 * The owner's archive page.
 *
 * Deliberately unlinked and `noindex`: the product says nothing about storage to users, so
 * it must not advertise a storage page either. It exists for the one person who knows the
 * URL and holds the key — see docs/SECURITY.md.
 */
export const metadata: Metadata = {
  title: 'AnonLink — архив (владельцу)',
  robots: { index: false, follow: false, nocache: true },
};

export default function AdminPage() {
  return <AdminScreen />;
}
