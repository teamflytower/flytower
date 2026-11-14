/** The create-server steps, in order. The progress view lists them; the runner reports them. */
export const CREATE_SERVER_STEPS = [
  'Checking the details',
  'Finding the download',
  'Installing Java',
  'Creating the server',
  'Downloading Minecraft',
  'Writing the config',
  'Starting the server',
] as const

export const IMPORT_STEPS = [
  'Checking the details',
  'Finding the download',
  'Installing Java',
  'Creating the server',
  'Downloading Minecraft',
  'Moving files in',
  'Writing the config',
  'Starting the server',
] as const

export const CLONE_STEPS = [
  'Checking the details',
  'Copying the server',
  'Finding the download',
  'Installing Java',
  'Creating the server',
  'Downloading Minecraft',
  'Moving files in',
  'Writing the config',
  'Starting the server',
] as const

export const WORLD_COPY_STEPS = [
  'Copying the world',
  'Backing up',
  'Stopping the server',
  'Replacing the world',
  'Starting the server',
] as const

export const UNPACK_STEPS = ['Getting the files', 'Unpacking', 'Looking inside'] as const

export const BACKUP_STEPS = [
  'Checking free space',
  'Saving the world',
  'Archiving',
  'Tidying old backups',
] as const

export const RESTORE_STEPS = [
  'Stopping the server',
  'Taking a safety copy',
  'Unpacking the backup',
  'Starting the server',
] as const

export const EXPORT_STEPS = [
  'Checking free space',
  'Saving the world',
  'Zipping the world',
] as const

export interface JobEvent {
  id: number
  state: 'queued' | 'running' | 'succeeded' | 'failed'
  step: string | null
  progress: number
  message: string | null
}

export const SPEC_STEPS = [
  'Checking the plan',
  'Backing up',
  'Downloading',
  'Stopping the server',
  'Installing',
  'Saving settings',
  'Starting the server',
] as const

export const WORLD_RESET_STEPS = [
  'Backing up',
  'Stopping the server',
  'Keeping the old world',
  'Clearing the world',
  'Setting the seed',
  'Starting the server',
] as const

export const WORLD_TRIM_STEPS = [
  'Checking free space',
  'Backing up',
  'Stopping the server',
  'Trimming',
  'Starting the server',
] as const
