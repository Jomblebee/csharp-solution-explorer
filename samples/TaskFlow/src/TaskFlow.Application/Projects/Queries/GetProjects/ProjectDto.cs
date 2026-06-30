namespace TaskFlow.Application.Projects.Queries.GetProjects;

public record ProjectDto(int Id, string Name, string? Description, int TaskCount);
