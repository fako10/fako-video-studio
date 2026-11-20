import { resolve } from 'node:path';
import type { Brand, Project } from '@prisma/client';
import type { BrandColors, BrandIdentity } from './contract.js';

export const DEFAULT_COLORS: BrandColors = { primary: '#1f63dd', secondary: '#0a1540', accent: '#ff5a1f', background: '#ffffff', text: '#0a1540' };

type Overrides = { colors?: Partial<BrandColors>; websiteUrl?: string; logoKey?: string };

/** Fusionne l'identité de la marque et les surcharges du projet. */
export function resolveBrandIdentity(project: Project & { brand: Brand | null }, brandAssetsRoot?: string): BrandIdentity {
    const overrides = (project.brandOverrides ?? {}) as Overrides;
    const brandColors = (project.brand?.colors ?? {}) as Partial<BrandColors>;
    const logoKey = overrides.logoKey ?? project.brand?.logoKey ?? undefined;
    return {
        slug: project.brand?.slug ?? project.slug ?? project.id,
        name: project.brand?.name ?? project.name,
        websiteUrl: overrides.websiteUrl ?? project.brand?.websiteUrl ?? undefined,
        logoPath: logoKey && brandAssetsRoot ? resolve(brandAssetsRoot, logoKey) : undefined,
        colors: { ...DEFAULT_COLORS, ...brandColors, ...overrides.colors }
    };
}
