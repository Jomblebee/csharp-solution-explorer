using TaskFlow.Domain.Enums;

namespace TaskFlow.Application.Tasks.Queries.GetTasksByProject;

public record TaskDto(int Id, string Title, string? Description, AppTaskStatus Status, Priority Priority);
