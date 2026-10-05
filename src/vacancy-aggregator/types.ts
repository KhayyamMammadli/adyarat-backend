export interface RawVacancy {
  external_id?: string;
  source_url: string;
  title: string;
  company?: string;
  category?: string;
  location?: string;
  work_mode?: string;
  salary?: string;
  salary_min?: number;
  salary_max?: number;
  currency?: string;
  salary_unit?: string;
  description?: string;
  requirements?: string;
  skills?: string[];
  published_at?: string;
  expires_at?: string;
  closed?: boolean;
}

export interface NormalizedVacancy {
  source: string;
  source_url: string;
  external_id: string;
  title: string;
  company: string | null;
  category: string | null;
  location: string | null;
  work_mode: 'office' | 'remote' | 'hybrid' | null;
  salary_min: number | null;
  salary_max: number | null;
  currency: string;
  description: string;
  requirements: string;
  skills: string[];
  published_at: string | null;
  expires_at: string | null;
  collected_at: string;
  status: 'pending' | 'closed';
  fingerprint: string;
}

export interface SourceAdapter {
  readonly source: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
  collect(signal: AbortSignal): Promise<RawVacancy[]>;
}

// AI only enriches missing semantic fields; it cannot change identity, pay or approval.
export interface SemanticNormalizationProvider {
  enrich(
    raw: RawVacancy,
    signal: AbortSignal,
  ): Promise<Partial<Pick<RawVacancy, 'category' | 'skills' | 'work_mode' | 'requirements'>>>;
}

export interface VacancyNotificationPlanner {
  plan(profileId: string, vacancyId: number): Promise<boolean>;
}
